import { describe, expect, it } from "bun:test";
import type { AgentPhase, AgentSession, ExecutableTool } from "../src/index.ts";
import {
  abortIgnoringTool,
  collect,
  fakeTool,
  fakeWriteTool,
  openTestSession,
  streamOf,
  textTurn,
  toolCallTurn,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Cancel session test task" };

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitForPhase(session: AgentSession, targetPhase: AgentPhase): Promise<void> {
  if (session.snapshot().phase === targetPhase) return;
  for await (const _event of session.events()) {
    if (session.snapshot().phase === targetPhase) return;
  }
}

describe("cancelling an Agent Session", () => {
  describe("Cancellation from ready state", () => {
    it("settles as cancelled synchronously with cancellation_requested and session_settled events", async () => {
      const { session } = openTestSession();

      expect(session.snapshot().phase).toBe("ready");

      const dispatchResult = await session.dispatch({
        type: "cancel",
        reason: "user decided to stop",
      });
      expect(dispatchResult.accepted).toBe(true);

      const state = session.snapshot();
      expect(state.phase).toBe("cancelled");
      if (state.phase === "cancelled") {
        expect(state.result.outcome).toBe("cancelled");
        expect(state.result.cancellation.reason).toBe("user decided to stop");
        expect(state.result.workspaceChanged).toBe(false);
        expect(state.result.partialChangesPossible).toBe(false);
      }

      const result = await session.result();
      expect(result.outcome).toBe("cancelled");
      if (result.outcome === "cancelled") {
        expect(result.cancellation.reason).toBe("user decided to stop");
      }

      const events = await collect(session.events());
      expect(events.map((e) => e.type)).toEqual(["cancellation_requested", "session_settled"]);
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
      const { session } = openTestSession({
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
                await waitForPhase(session, "cancelling");
                aborted = true;
                yield { type: "content_block_stop", index: 0 };
                throw new Error("model stream aborted");
              }),
          ],
        },
      });

      await session.dispatch({ type: "start", task });
      await waitForEvent(session, "assistant_content_delta");
      expect(session.snapshot().phase).toBe("streaming_model");

      const cancelPromise = session.dispatch({ type: "cancel", reason: "taking too long" });
      const cancelResult = await cancelPromise;
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await session.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(aborted).toBe(true);
      expect(session.snapshot().phase).toBe("cancelled");

      const events = await collect(session.events());
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
  });

  describe("Cancellation from awaiting_approval state", () => {
    it("resolves the pending approval as cancelled with decidedBy user, skips the tool call and remaining queue, and completes model turn as cancelled", async () => {
      const { session } = openTestSession({
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

      await session.dispatch({ type: "start", task });
      await waitForEvent(session, "approval_requested");
      expect(session.snapshot().phase).toBe("awaiting_approval");

      const cancelResult = await session.dispatch({
        type: "cancel",
        reason: "stop before writing",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await session.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(terminalResult.workspaceChanged).toBe(false);
      expect(terminalResult.partialChangesPossible).toBe(false);

      const events = await collect(session.events());

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
      });
      expect(toolCompletions[1]?.data).toEqual({
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "CANCELLED",
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

      const { session } = openTestSession({
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

      await session.dispatch({ type: "start", task });
      await waitForEvent(session, "tool_execution_started");
      expect(session.snapshot().phase).toBe("executing_tool");

      const cancelResult = await session.dispatch({
        type: "cancel",
        reason: "aborted by developer",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await session.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(toolAborted).toBe(true);
      expect(terminalResult.workspaceChanged).toBe(true);
      expect(terminalResult.partialChangesPossible).toBe(true);

      const events = await collect(session.events());
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
      });

      const turnCompleted = events.find((e) => e.type === "model_turn_completed");
      expect(turnCompleted?.data).toMatchObject({
        outcome: "cancelled",
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

      const { session } = openTestSession({
        tools: [slowPreflightTool],
        model: {
          turns: [toolCallTurn({ toolCallId: "call-1", name: "slow_prepare", input: {} })],
        },
      });

      await session.dispatch({ type: "start", task });
      await prepareStarted.promise;

      await session.dispatch({ type: "cancel", reason: "cancelled during prepare" });
      const terminalResult = await session.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(prepareSignalAborted).toBe(true);

      const events = await collect(session.events());
      expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);

      const toolCompleted = events.find((e) => e.type === "tool_call_completed");
      expect(toolCompleted?.data).toEqual({
        toolCallId: "tool_call-1",
        outcome: "skipped",
        reason: "CANCELLED",
      });
    });
  });

  describe("Cancellation from verifying state", () => {
    it("aborts active verification, completes verification run with cancelled, and settles as cancelled", async () => {
      let verificationAborted = false;
      const { session } = openTestSession({
        verification: [
          async (_candidate) => {
            await waitForPhase(session, "cancelling");
            verificationAborted = true;
            return { outcome: "succeeded", evidence: [] };
          },
        ],
        model: {
          turns: [textTurn("Done with code change")],
        },
      });

      await session.dispatch({ type: "start", task });
      await waitForEvent(session, "verification_started");
      expect(session.snapshot().phase).toBe("verifying");

      const cancelResult = await session.dispatch({
        type: "cancel",
        reason: "verification not needed",
      });
      expect(cancelResult.accepted).toBe(true);

      const terminalResult = await session.result();
      expect(terminalResult.outcome).toBe("cancelled");
      expect(verificationAborted).toBe(true);

      const events = await collect(session.events());
      const verCompleted = events.find((e) => e.type === "verification_completed");
      expect(verCompleted?.data).toEqual({
        verificationId: "verification-1",
        outcome: "cancelled",
        evidence: [],
      });
    });
  });

  describe("Cancellation grace period timeout", () => {
    it("settles as failed with CANCELLATION_TIMEOUT when an adapter ignores abort past cancellationGraceMs", async () => {
      const stubborn = abortIgnoringTool();
      const { session } = openTestSession({
        tools: [stubborn],
        approvalPolicy: "auto-approve",
        limits: {
          cancellationGraceMs: 25,
        },
        model: {
          turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })],
        },
      });

      await session.dispatch({ type: "start", task });
      await waitForEvent(session, "tool_execution_started");

      await session.dispatch({ type: "cancel", reason: "timed out cancellation" });

      const terminalResult = await session.result();
      expect(terminalResult.outcome).toBe("failed");
      if (terminalResult.outcome === "failed") {
        expect(terminalResult.failure.code).toBe("CANCELLATION_TIMEOUT");
        expect(terminalResult.failure.message).toContain("cancellation grace period");
      }

      stubborn.release();
      await new Promise((r) => setTimeout(r, 10));
      expect(session.snapshot().phase).toBe("failed");
      const events = await collect(session.events());
      const settledEvents = events.filter((e) => e.type === "session_settled");
      expect(settledEvents).toHaveLength(1);
    });
  });

  describe("Repeated cancellation and terminal state rules", () => {
    it("returns accepted: true with current sequence when cancelling an already cancelling or cancelled session", async () => {
      const { session } = openTestSession();

      const firstCancel = await session.dispatch({ type: "cancel", reason: "first" });
      expect(firstCancel.accepted).toBe(true);

      const secondCancel = await session.dispatch({ type: "cancel", reason: "second" });
      expect(secondCancel.accepted).toBe(true);
      if (secondCancel.accepted) {
        expect(secondCancel.sequence).toBe(session.snapshot().lastSequence);
      }
    });

    it("returns ALREADY_SETTLED when cancelling after succeeded or failed", async () => {
      const { session } = openTestSession({
        model: { turns: [textTurn("All done")] },
      });

      await session.dispatch({ type: "start", task });
      const result = await session.result();
      expect(result.outcome).toBe("succeeded");

      const cancelResult = await session.dispatch({ type: "cancel" });
      expect(cancelResult).toEqual({
        accepted: false,
        code: "ALREADY_SETTLED",
        message: "the session has already succeeded",
      });
    });
  });

  describe("safety net hardening during cancellation and settlement", () => {
    it("guarantees session_settled and result resolution even when clock.now throws during cancellation", async () => {
      let throwClock = false;
      const { session, clock } = openTestSession();

      const originalNow = clock.now;
      clock.now = () => {
        if (throwClock) {
          throw new Error("clock hardware failure");
        }
        return originalNow();
      };

      throwClock = true;
      const cancelResult = await session.dispatch({ type: "cancel" });
      expect(cancelResult.accepted).toBe(true);

      const result = await session.result();
      expect(result.outcome).toBe("cancelled");
    });
  });
});
