import { describe, expect, it } from "bun:test";
import type { AgentPhase, AgentRun, ExecutableTool } from "../src/index.ts";
import {
  abortIgnoringTool,
  collect,
  fakeTool,
  fakeWriteTool,
  openTestRun,
  streamOf,
  textMessage,
  textTurn,
  toolCallTurn,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Cancel run test task" };

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitForPhase(run: AgentRun, targetPhase: AgentPhase): Promise<void> {
  if (run.snapshot().phase === targetPhase) return;
  for await (const _event of run.events()) {
    if (run.snapshot().phase === targetPhase) return;
  }
}

describe("cancelling an Agent Run", () => {
  describe("Cancellation from ready state", () => {
    it("settles as cancelled synchronously with cancellation_requested and run_settled events", async () => {
      const { run } = openTestRun();

      expect(run.snapshot().phase).toBe("ready");

      const dispatchResult = await run.dispatch({
        type: "cancel",
        reason: "user decided to stop",
      });
      expect(dispatchResult.accepted).toBe(true);

      const state = run.snapshot();
      expect(state.phase).toBe("cancelled");
      if (state.phase === "cancelled") {
        expect(state.result.outcome).toBe("cancelled");
        expect(state.result.cancellation.reason).toBe("user decided to stop");
        expect(state.result.workspaceChanged).toBe(false);
        expect(state.result.partialChangesPossible).toBe(false);
      }

      const result = await run.result();
      expect(result.outcome).toBe("cancelled");
      if (result.outcome === "cancelled") {
        expect(result.cancellation.reason).toBe("user decided to stop");
      }

      const events = await collect(run.events());
      expect(events.map((e) => e.type)).toEqual(["cancellation_requested", "run_settled"]);
      expect(events[0]?.data).toEqual({
        requestedFrom: "ready",
        reason: "user decided to stop",
      });
      expect(events[1]?.data).toEqual({
        result: expect.objectContaining({ outcome: "cancelled" }),
      });
    });
  });

  describe("Cancellation from streaming_model state", () => {
    it("aborts the active model stream, completes the partial assistant message and turn as cancelled, and settles", async () => {
      let aborted = false;
      const { run } = openTestRun({
        model: {
          turns: [
            () =>
              streamOf(async function* () {
                yield { type: "stream_start" };
                yield {
                  type: "content_block_start",
                  index: 0,
                  block: { type: "text", text: "" },
                };
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Working on it..." },
                };
                await waitForPhase(run, "cancelling");
                aborted = true;
                yield { type: "content_block_stop", index: 0 };
                throw new Error("model stream aborted");
              }),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "assistant_content_delta");
      expect(run.snapshot().phase).toBe("streaming_model");

      const cancelPromise = run.dispatch({ type: "cancel", reason: "taking too long" });
      const cancelResult = await cancelPromise;
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(aborted).toBe(true);
      expect(run.snapshot().phase).toBe("cancelled");

      const events = await collect(run.events());
      const cancelReq = events.find((e) => e.type === "cancellation_requested");
      expect(cancelReq?.data).toEqual({
        requestedFrom: "streaming_model",
        reason: "taking too long",
      });

      const msgCompleted = events.find((e) => e.type === "assistant_message_completed");
      expect(msgCompleted?.data).toMatchObject({
        outcome: "cancelled",
        message: expect.objectContaining({
          role: "assistant",
          finishReason: { reason: "other", rawReason: "cancelled" },
        }),
      });

      const turnCompleted = events.find((e) => e.type === "model_turn_completed");
      expect(turnCompleted?.data).toMatchObject({
        outcome: "cancelled",
      });
    });

    it("drops content delta arriving after cancellation and settles as cancelled", async () => {
      const { run } = openTestRun({
        model: {
          turns: [
            () =>
              streamOf(async function* () {
                yield { type: "stream_start" };
                yield {
                  type: "content_block_start",
                  index: 0,
                  block: { type: "text", text: "" },
                };
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Part 1" },
                };
                await waitForPhase(run, "cancelling");
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: " - Part 2 after cancel" },
                };
                yield { type: "content_block_stop", index: 0 };
                yield { type: "turn_end", message: textMessage("Part 1") };
              }),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "assistant_content_delta");
      const cancelResult = await run.dispatch({ type: "cancel" });
      expect(cancelResult.accepted).toBe(true);

      const result = await run.result();
      expect(result.outcome).toBe("cancelled");
      expect(run.snapshot().phase).toBe("cancelled");

      const events = await collect(run.events());
      const deltas = events.filter((e) => e.type === "assistant_content_delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0]?.data.delta).toBe("Part 1");

      const messageCompleted = events.find((e) => e.type === "assistant_message_completed");
      expect(messageCompleted?.data.outcome).toBe("cancelled");
      const textBlock = messageCompleted?.data.message.content.find((b) => b.type === "text");
      expect(textBlock?.text).toBe("Part 1");
    });

    it("drops content delta arriving after cancellation grace period expires and does not emit after run_settled", async () => {
      const finished = Promise.withResolvers<void>();
      let pushDelta: ((text: string) => void) | undefined;
      const { run, clock } = openTestRun({
        limits: { cancellationGraceMs: 20 },
        model: {
          turns: [
            () =>
              streamOf(async function* () {
                yield { type: "stream_start" };
                yield {
                  type: "content_block_start",
                  index: 0,
                  block: { type: "text", text: "" },
                };
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Initial stream" },
                };
                const queue: string[] = [];
                let notify: (() => void) | undefined;
                pushDelta = (t) => {
                  queue.push(t);
                  notify?.();
                };
                while (true) {
                  const text = queue.shift();
                  if (text !== undefined) {
                    yield {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text },
                    };
                  } else {
                    await Promise.race([
                      new Promise<void>((r) => {
                        notify = r;
                      }),
                      finished.promise,
                    ]);
                    if (queue.length === 0) break;
                  }
                }
                yield { type: "content_block_stop", index: 0 };
                yield { type: "turn_end", message: textMessage("Initial stream") };
              }),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "assistant_content_delta");
      await run.dispatch({ type: "cancel" });

      clock.advance(300);
      const result = await run.result();
      expect(result.outcome).toBe("failed");
      expect(result.outcome === "failed" && result.failure.code).toBe("CANCELLATION_TIMEOUT");
      expect(run.snapshot().phase).toBe("failed");

      pushDelta?.("Late delta after grace expired");
      clock.advance(100);
      finished.resolve();

      const events = await collect(run.events());
      const settledIndex = events.findIndex((e) => e.type === "run_settled");
      expect(settledIndex).toBe(events.length - 1);
      const settledCount = events.filter((e) => e.type === "run_settled").length;
      expect(settledCount).toBe(1);

      const deltas = events.filter((e) => e.type === "assistant_content_delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0]?.data.delta).toBe("Initial stream");
    });
  });

  describe("Cancellation from awaiting_approval state", () => {
    it("resolves the pending approval as cancelled with decidedBy user, skips the tool call and remaining queue, and completes model turn as cancelled", async () => {
      const { run } = openTestRun({
        tools: [fakeWriteTool()],
        approvalPolicy: "ask",
        model: {
          turns: [
            toolCallTurn(
              { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
              { toolCallId: "call-2", name: "write", input: { path: "src/b.ts" } },
            ),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "approval_requested");
      expect(run.snapshot().phase).toBe("awaiting_approval");

      const cancelResult = await run.dispatch({
        type: "cancel",
        reason: "stop before writing",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(terminalResult.workspaceChanged).toBe(false);
      expect(terminalResult.partialChangesPossible).toBe(false);

      const events = await collect(run.events());

      const approvalResolved = events.find((e) => e.type === "approval_resolved");
      expect(approvalResolved?.data).toMatchObject({
        approvalId: "approval-1",
        toolCallId: "tool_call-1",
        status: "cancelled",
        decidedBy: "user",
        reason: "stop before writing",
      });

      const toolCompletions = events.filter((e) => e.type === "tool_call_completed");
      expect(toolCompletions).toHaveLength(2);
      expect(toolCompletions[0]?.data).toEqual({
        toolCallId: "tool_call-1",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-1",
          toolName: "write",
          content: "write not run: CANCELLED",
          isError: true,
        },
      });
      expect(toolCompletions[1]?.data).toEqual({
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-2",
          toolName: "write",
          content: "write not run: CANCELLED",
          isError: true,
        },
      });

      const turnCompleted = events.find((e) => e.type === "model_turn_completed");
      expect(turnCompleted?.data).toMatchObject({
        outcome: "cancelled",
      });
    });
  });

  describe("Cancellation from executing_tool state", () => {
    it("aborts executing tool call, records executing call as cancelled, skips remaining queued calls in model order", async () => {
      let toolAborted = false;
      const stubbornTool: ExecutableTool = {
        ...fakeTool({ name: "long_task", mutation: "mutating" }),
        async execute(_prepared, ctx) {
          await waitForAbort(ctx.signal);
          toolAborted = true;
          return {
            isError: true,
            content: "aborted during execution",
            error: { code: "TOOL_INTERNAL_ERROR", message: "aborted during execution" },
          };
        },
      };

      const { run } = openTestRun({
        tools: [stubbornTool],
        approvalPolicy: "auto-approve",
        model: {
          turns: [
            toolCallTurn(
              { toolCallId: "call-1", name: "long_task", input: {} },
              { toolCallId: "call-2", name: "long_task", input: {} },
            ),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "tool_execution_started");
      expect(run.snapshot().phase).toBe("executing_tool");

      const cancelResult = await run.dispatch({
        type: "cancel",
        reason: "aborted by developer",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(toolAborted).toBe(true);
      expect(terminalResult.workspaceChanged).toBe(true);
      expect(terminalResult.partialChangesPossible).toBe(true);

      const events = await collect(run.events());
      const toolCompletions = events.filter((e) => e.type === "tool_call_completed");
      expect(toolCompletions).toHaveLength(2);
      expect(toolCompletions[0]?.data).toMatchObject({
        toolCallId: "tool_call-1",
        outcome: "cancelled",
      });
      expect(toolCompletions[1]?.data).toEqual({
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-2",
          toolName: "long_task",
          content: "long_task not run: CANCELLED",
          isError: true,
        },
      });

      const turnCompleted = events.find((e) => e.type === "model_turn_completed");
      expect(turnCompleted?.data).toMatchObject({
        outcome: "cancelled",
      });
    });

    it("records executing tool call as cancelled when execute rejects after abort, skipping unstarted queued calls", async () => {
      let toolAborted = false;
      const rejectingTool: ExecutableTool = {
        ...fakeTool({ name: "exploding_task", mutation: "mutating" }),
        async execute(_prepared, ctx) {
          await waitForAbort(ctx.signal);
          toolAborted = true;
          throw new Error("adapter exploded during cancellation abort");
        },
      };

      const { run } = openTestRun({
        tools: [rejectingTool],
        approvalPolicy: "auto-approve",
        model: {
          turns: [
            toolCallTurn(
              { toolCallId: "call-1", name: "exploding_task", input: {} },
              { toolCallId: "call-2", name: "exploding_task", input: {} },
            ),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "tool_execution_started");
      expect(run.snapshot().phase).toBe("executing_tool");

      const cancelResult = await run.dispatch({
        type: "cancel",
        reason: "aborted by developer",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(toolAborted).toBe(true);

      const events = await collect(run.events());
      const toolCompletions = events.filter((e) => e.type === "tool_call_completed");
      expect(toolCompletions).toHaveLength(2);
      expect(toolCompletions[0]?.data).toMatchObject({
        toolCallId: "tool_call-1",
        outcome: "cancelled",
        result: {
          toolCallId: "tool_call-1",
          content: expect.stringContaining("adapter exploded during cancellation abort"),
          isError: true,
          error: { code: "TOOL_INTERNAL_ERROR" },
        },
      });
      expect(toolCompletions[1]?.data).toEqual({
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-2",
          toolName: "exploding_task",
          content: "exploding_task not run: CANCELLED",
          isError: true,
        },
      });
    });

    it("records tool call as skipped if cancelled during preflight before tool_execution_started", async () => {
      let prepareSignalAborted = false;
      const prepareStarted = Promise.withResolvers<void>();
      const slowPreflightTool: ExecutableTool = {
        ...fakeTool({ name: "slow_prepare" }),
        async prepare(input, ctx) {
          prepareStarted.resolve();
          await waitForAbort(ctx.signal);
          prepareSignalAborted = true;
          return { ok: true, prepared: { input, paths: [], summary: "slow_prepare" } };
        },
      };

      const { run } = openTestRun({
        tools: [slowPreflightTool],
        model: {
          turns: [toolCallTurn({ toolCallId: "call-1", name: "slow_prepare", input: {} })],
        },
      });

      await run.dispatch({ type: "start", task });
      await prepareStarted.promise;

      await run.dispatch({ type: "cancel", reason: "cancelled during prepare" });
      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(prepareSignalAborted).toBe(true);

      const events = await collect(run.events());
      expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);

      const toolCompleted = events.find((e) => e.type === "tool_call_completed");
      expect(toolCompleted?.data).toEqual({
        toolCallId: "tool_call-1",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-1",
          toolName: "slow_prepare",
          content: "slow_prepare not run: CANCELLED",
          isError: true,
        },
      });
    });
  });

  describe("Cancellation from verifying state", () => {
    it("aborts active verification, completes verification run with cancelled, and settles as cancelled", async () => {
      let verificationAborted = false;
      const { run } = openTestRun({
        verification: [
          async (_candidate) => {
            await waitForPhase(run, "cancelling");
            verificationAborted = true;
            return { outcome: "succeeded", evidence: [] };
          },
        ],
        model: {
          turns: [textTurn("Done with code change")],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "verification_started");
      expect(run.snapshot().phase).toBe("verifying");

      const cancelResult = await run.dispatch({
        type: "cancel",
        reason: "verification not needed",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(verificationAborted).toBe(true);

      const events = await collect(run.events());
      const verCompleted = events.find((e) => e.type === "verification_completed");
      expect(verCompleted?.data).toEqual({
        verificationId: "verification-1",
        outcome: "cancelled",
        evidence: [],
      });
    });

    it("settles as cancelled when the policy reports the aborted run as cancelled", async () => {
      const { run } = openTestRun({
        verification: [
          async () => {
            await waitForPhase(run, "cancelling");
            return { outcome: "cancelled" };
          },
        ],
        model: { turns: [textTurn("Done with code change")] },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "verification_started");
      await run.dispatch({ type: "cancel" });

      expect((await run.result()).outcome).toBe("cancelled");
      const events = await collect(run.events());
      expect(events.filter((e) => e.type === "verification_completed")).toMatchObject([
        { data: { verificationId: "verification-1", outcome: "cancelled", evidence: [] } },
      ]);
    });
  });

  describe("Cancellation between model turns", () => {
    it("quiesces cleanly and does not schedule a new model turn when cancellation is requested between turns", async () => {
      let turn2Started = false;
      let tool1Executed = false;

      let runRef: AgentRun | undefined;
      const tool: ExecutableTool = {
        ...fakeTool({ name: "step_one" }),
        async execute() {
          tool1Executed = true;
          void runRef?.dispatch({ type: "cancel", reason: "stop after step 1" });
          return { isError: false, content: "step 1 complete" };
        },
      };

      const { run } = openTestRun({
        tools: [tool],
        approvalPolicy: "auto-approve",
        model: {
          turns: [
            toolCallTurn({ toolCallId: "call-1", name: "step_one", input: {} }),
            () => {
              turn2Started = true;
              return streamOf(async function* () {
                yield* textTurn("Step 2 response");
              });
            },
          ],
        },
      });
      runRef = run;

      await run.dispatch({ type: "start", task });

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(tool1Executed).toBe(true);
      expect(turn2Started).toBe(false);

      const events = await collect(run.events());
      const modelTurnsStarted = events.filter((e) => e.type === "model_turn_started");
      expect(modelTurnsStarted).toHaveLength(1);

      const assistantStarted = events.filter((e) => e.type === "assistant_message_started");
      expect(assistantStarted).toHaveLength(1);

      const settled = events.find((e) => e.type === "run_settled");
      expect(settled).toBeDefined();
      expect(run.snapshot().phase).toBe("cancelled");
    });

    it("quiesces cleanly and does not schedule a new model turn when cancellation occurs after verification continues", async () => {
      let turn2Started = false;
      let runRef: AgentRun | undefined;

      const { run } = openTestRun({
        model: {
          turns: [
            textTurn("Candidate answer"),
            () => {
              turn2Started = true;
              return streamOf(async function* () {
                yield* textTurn("Next turn answer");
              });
            },
          ],
        },
        verification: [
          async () => {
            void runRef?.dispatch({
              type: "cancel",
              reason: "stop after verification continue",
            });
            return {
              outcome: "continue",
              evidence: [],
              feedback: { role: "user", content: "Needs more work" },
            };
          },
        ],
      });
      runRef = run;

      await run.dispatch({ type: "start", task });

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(turn2Started).toBe(false);

      const events = await collect(run.events());
      const modelTurnsStarted = events.filter((e) => e.type === "model_turn_started");
      expect(modelTurnsStarted).toHaveLength(1);
      expect(run.snapshot().phase).toBe("cancelled");
    });
  });

  describe("Cancellation grace period expiration", () => {
    it("settles as failed with CANCELLATION_TIMEOUT when an adapter ignores abort past cancellationGraceMs", async () => {
      const stubborn = abortIgnoringTool();
      const { run, clock } = openTestRun({
        tools: [stubborn],
        approvalPolicy: "auto-approve",
        limits: {
          cancellationGraceMs: 25,
        },
        model: {
          turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })],
        },
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "tool_execution_started");

      await run.dispatch({ type: "cancel", reason: "timed out cancellation" });
      clock.advance(25);

      const terminalResult = await run.result();
      expect(terminalResult.outcome).toBe("failed");
      if (terminalResult.outcome === "failed") {
        expect(terminalResult.failure.code).toBe("CANCELLATION_TIMEOUT");
        expect(terminalResult.failure.message).toContain("cancellation grace period");
      }

      stubborn.release();
      expect(run.snapshot().phase).toBe("failed");
      const events = await collect(run.events());
      const settledEvents = events.filter((e) => e.type === "run_settled");
      expect(settledEvents).toHaveLength(1);
    });

    it("settles as failed with CANCELLATION_TIMEOUT when verification ignores abort past cancellationGraceMs", async () => {
      const release = Promise.withResolvers<void>();
      const { run, clock } = openTestRun({
        limits: { cancellationGraceMs: 25 },
        model: { turns: [textTurn("Candidate message")] },
        verification: [
          () =>
            new Promise((resolve) => {
              release.promise.then(() => {
                resolve({
                  outcome: "succeeded",
                  evidence: [
                    {
                      type: "command_execution",
                      command: "test",
                      exitCode: 0,
                      stdout: "ok",
                      stderr: "",
                      durationMs: 1,
                    },
                  ],
                });
              });
            }),
        ],
      });

      await run.dispatch({ type: "start", task });
      await waitForEvent(run, "verification_started");

      await run.dispatch({ type: "cancel" });
      expect(run.snapshot().phase).toBe("cancelling");

      clock.advance(50);
      const result = await run.result();
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") {
        expect(result.failure.code).toBe("CANCELLATION_TIMEOUT");
        expect(result.failure.message).toContain("cancellation grace period");
      }
      expect(run.snapshot().phase).toBe("failed");

      release.resolve();
      const events = await collect(run.events());
      const settledEvents = events.filter((e) => e.type === "run_settled");
      expect(settledEvents).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run_settled");
    });
  });

  describe("Repeated cancellation and terminal state rules", () => {
    it("returns accepted: true with current sequence when cancelling an already cancelling or cancelled run", async () => {
      // 1. Cancelled from ready (synchronous -> cancelled phase)
      const { run: syncRun } = openTestRun();

      const firstCancel = await syncRun.dispatch({ type: "cancel", reason: "first" });
      expect(firstCancel.accepted).toBe(true);
      expect(syncRun.snapshot().phase).toBe("cancelled");

      const secondCancel = await syncRun.dispatch({ type: "cancel", reason: "second" });
      expect(secondCancel.accepted).toBe(true);
      if (secondCancel.accepted) {
        expect(secondCancel.sequence).toBe(syncRun.snapshot().lastSequence);
      }

      // 2. Cancel while in cancelling phase (async work in flight)
      const stubborn = abortIgnoringTool();
      const { run: asyncRun } = openTestRun({
        tools: [stubborn],
        approvalPolicy: "auto-approve",
        model: { turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })] },
      });

      await asyncRun.dispatch({ type: "start", task });
      await waitForEvent(asyncRun, "tool_execution_started");

      const firstAsyncCancel = await asyncRun.dispatch({
        type: "cancel",
        reason: "cancelling first",
      });
      expect(firstAsyncCancel.accepted).toBe(true);
      expect(asyncRun.snapshot().phase).toBe("cancelling");

      const secondAsyncCancel = await asyncRun.dispatch({
        type: "cancel",
        reason: "cancelling second",
      });
      expect(secondAsyncCancel.accepted).toBe(true);
      if (secondAsyncCancel.accepted) {
        expect(secondAsyncCancel.sequence).toBe(asyncRun.snapshot().lastSequence);
      }

      stubborn.release();
      const asyncResult = await asyncRun.result();
      expect(asyncResult.outcome).toBe("cancelled");
      expect(asyncRun.snapshot().phase).toBe("cancelled");
    });

    it("returns ALREADY_SETTLED when cancelling after succeeded or failed", async () => {
      // 1. After succeeded
      const { run: succeededRun } = openTestRun({
        model: { turns: [textTurn("All done")] },
      });

      await succeededRun.dispatch({ type: "start", task });
      const succeededResult = await succeededRun.result();
      expect(succeededResult.outcome).toBe("succeeded");

      const cancelSucceeded = await succeededRun.dispatch({ type: "cancel" });
      expect(cancelSucceeded).toEqual({
        accepted: false,
        code: "ALREADY_SETTLED",
        message: "the run has already succeeded",
      });

      // 2. After failed
      const { run: failedRun } = openTestRun({
        model: {
          turns: [
            () => {
              throw new Error("fatal model error");
            },
          ],
        },
      });

      await failedRun.dispatch({ type: "start", task });
      const failedResult = await failedRun.result();
      expect(failedResult.outcome).toBe("failed");

      const cancelFailed = await failedRun.dispatch({ type: "cancel" });
      expect(cancelFailed).toEqual({
        accepted: false,
        code: "ALREADY_SETTLED",
        message: "the run has already failed",
      });
    });
  });

  describe("safety net hardening during cancellation and settlement", () => {
    it("guarantees run_settled and result resolution even when clock.now throws during cancellation", async () => {
      let throwClock = false;
      const { run, clock } = openTestRun();

      const originalNow = clock.now;
      clock.now = () => {
        if (throwClock) {
          throw new Error("clock hardware failure");
        }
        return originalNow();
      };

      throwClock = true;
      const cancelResult = await run.dispatch({ type: "cancel" });
      expect(cancelResult.accepted).toBe(true);

      const result = await run.result();
      expect(result.outcome).toBe("cancelled");
    });

    it("guarantees run_settled even when clock.now throws from startup before any timestamp is recorded", async () => {
      const { run, clock } = openTestRun();
      clock.now = () => {
        throw new Error("clock hardware failure at startup");
      };

      const cancelResult = await run.dispatch({ type: "cancel" });
      expect(cancelResult.accepted).toBe(true);

      const result = await run.result();
      expect(result.outcome).toBe("cancelled");

      const events = await collect(run.events());
      const settled = events.find((e) => e.type === "run_settled");
      expect(settled).toBeDefined();
      expect(settled?.occurredAt).toBe("1970-01-01T00:00:00.000Z");
    });
  });
});
