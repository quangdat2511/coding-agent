import { describe, expect, it } from "bun:test";
import {
  type AgentSession,
  type ExecutableTool,
  openAgentSession,
  type VerificationDecision,
} from "../src/index.ts";
import {
  abortIgnoringTool,
  collect,
  continueWith,
  createTestKit,
  fakeTool,
  fakeWriteTool,
  openTestSession,
  streamOf,
  textMessage,
  textTurn,
  throwingTool,
  toolCallTurn,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

describe("Session Limits", () => {
  it("stops before starting a Model Turn beyond maxModelTurns", async () => {
    const { session, model } = openTestSession({
      model: { turns: [textTurn("Try again."), textTurn("Done.")] },
      verification: [
        { outcome: "continue", evidence: [], feedback: { role: "user", content: "Try again." } },
      ],
      limits: { maxModelTurns: 1 },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(model.requests).toHaveLength(1);
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      type: "runtime_limit_reached",
      data: { kind: "maxModelTurns", limit: 1, observed: 1 },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "LIMIT_EXCEEDED" },
    });
  });

  it("skips remaining Tool Calls in model order when maxToolCalls is reached", async () => {
    const { session, portCalls } = openTestSession({
      tools: [fakeTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "echo", input: {} },
            { toolCallId: "call-2", name: "echo", input: {} },
            { toolCallId: "call-3", name: "echo", input: {} },
            { toolCallId: "call-4", name: "echo", input: {} },
            { toolCallId: "call-5", name: "echo", input: {} },
          ),
          textTurn("Done."),
        ],
      },
      limits: { maxToolCalls: 3 },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());
    const completions = events.filter((event) => event.type === "tool_call_completed");

    expect(portCalls.filter((call) => call === "tool.execute(echo)")).toHaveLength(3);
    expect(completions.map((event) => event.data)).toEqual([
      { toolCallId: "tool_call-1", outcome: "succeeded", result: expect.any(Object) },
      { toolCallId: "tool_call-2", outcome: "succeeded", result: expect.any(Object) },
      { toolCallId: "tool_call-3", outcome: "succeeded", result: expect.any(Object) },
      { toolCallId: "tool_call-4", outcome: "skipped", reason: "LIMIT_EXCEEDED" },
      { toolCallId: "tool_call-5", outcome: "skipped", reason: "LIMIT_EXCEEDED" },
    ]);
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxToolCalls", limit: 3, observed: 3 },
    });
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
  });

  it("marks partial changes possible when a completed mutating call precedes a Tool Call limit", async () => {
    const { session } = openTestSession({
      approvalPolicy: "auto-approve",
      tools: [fakeWriteTool(), fakeTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "echo", input: {} },
          ),
        ],
      },
      limits: { maxToolCalls: 1 },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(
      events
        .filter((event) => event.type === "tool_call_completed")
        .map((event) => [event.data.toolCallId, event.data.outcome]),
    ).toEqual([
      ["tool_call-1", "succeeded"],
      ["tool_call-2", "skipped"],
    ]);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "LIMIT_EXCEEDED" },
      workspaceChanged: true,
      partialChangesPossible: true,
    });
  });

  it("aborts a Model Turn when active duration expires", async () => {
    let releaseStream: (() => void) | undefined;
    const { session, model, clock } = openTestSession({
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
                delta: { type: "text_delta", text: "Working" },
              };
              await new Promise<void>((resolve) => {
                releaseStream = resolve;
              });
              yield { type: "content_block_stop", index: 0 };
              yield { type: "turn_end", message: textMessage("Working") };
            }),
        ],
      },
      limits: { maxDurationMs: 10 },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "assistant_content_delta");
    const request = model.requests[0];
    if (request === undefined) throw new Error("expected the model request to start");
    const signal = request.signal;
    signal.addEventListener("abort", () => releaseStream?.(), { once: true });
    clock.advance(10);

    const result = await session.result();
    const events = await collect(session.events());

    expect(signal.aborted).toBe(true);
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxDurationMs", limit: 10, observed: 10 },
    });
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
  });

  it("aborts Tool Call preparation when active duration expires", async () => {
    let prepareSignal: AbortSignal | undefined;
    let prepareStarted!: () => void;
    let finishPrepare: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      prepareStarted = resolve;
    });
    const slowPrepare: ExecutableTool = {
      ...fakeTool({ name: "slow-prepare" }),
      prepare(input, { signal }) {
        prepareSignal = signal;
        prepareStarted();
        return new Promise((resolve) => {
          finishPrepare = () =>
            resolve({
              ok: true,
              prepared: { input, paths: [], summary: "prepared" },
            });
          signal.addEventListener("abort", () => finishPrepare?.(), { once: true });
        });
      },
    };
    const { session, clock, portCalls } = openTestSession({
      tools: [slowPrepare],
      model: {
        turns: [toolCallTurn({ toolCallId: "call-1", name: "slow-prepare", input: {} })],
      },
      approvalPolicy: "auto-approve",
      limits: { maxDurationMs: 10 },
    });

    await session.dispatch({ type: "start", task });
    await started;
    clock.advance(10);
    if (!prepareSignal?.aborted) finishPrepare?.();
    const result = await session.result();
    const events = await collect(session.events());

    expect(prepareSignal?.aborted).toBe(true);
    expect(portCalls).not.toContain("tool.execute(slow-prepare)");
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxDurationMs", limit: 10, observed: 10 },
    });
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
  });

  it("settles with LIMIT_EXCEEDED after grace when an in-flight Tool Call ignores abort", async () => {
    const stubborn = abortIgnoringTool();
    let executionSignal: AbortSignal | undefined;
    const tool: ExecutableTool = {
      ...stubborn,
      execute(prepared, context) {
        executionSignal = context.signal;
        return stubborn.execute(prepared, context);
      },
    };
    const { session, clock } = openTestSession({
      tools: [tool],
      approvalPolicy: "auto-approve",
      model: {
        turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })],
      },
      limits: { maxDurationMs: 10, cancellationGraceMs: 25 },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "tool_execution_started");
    clock.advance(10);
    expect(executionSignal?.aborted).toBe(true);
    expect(session.snapshot().phase).toBe("executing_tool");

    clock.advance(25);
    const settledAfterGrace = session.snapshot().phase === "failed";
    if (!settledAfterGrace) stubborn.release();
    const result = await session.result();
    stubborn.release();
    const events = await collect(session.events());

    expect(settledAfterGrace).toBe(true);
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxDurationMs", limit: 10, observed: 10 },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "LIMIT_EXCEEDED" },
      partialChangesPossible: true,
    });
    expect(events.at(-1)?.type).toBe("session_settled");
  });

  it("excludes ready and awaiting_approval time from active duration", async () => {
    const write = fakeWriteTool();
    const { session, clock: sessionClock } = openTestSession({
      tools: [
        {
          ...write,
          async execute(prepared, context) {
            sessionClock.advance(500);
            return write.execute(prepared, context);
          },
        },
      ],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Done."),
        ],
      },
      limits: { maxDurationMs: 1_000 },
    });
    sessionClock.advance(60_000);
    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");
    expect(session.snapshot().activeDurationMs).toBe(0);

    sessionClock.advance(60_000);
    expect(session.snapshot().activeDurationMs).toBe(0);
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    const result = await session.result();

    expect(result.outcome).toBe("succeeded");
    expect(session.snapshot().activeDurationMs).toBe(500);
  });

  it("settles failed if the active clock cannot start after session_started", async () => {
    const { session, clock, model } = openTestSession({ model: { turns: [textTurn("Done.")] } });
    clock.monotonicMs = () => {
      throw new Error("monotonic clock failed at startup");
    };

    const start = await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(start.accepted).toBe(true);
    expect(model.requests).toHaveLength(0);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "INTERNAL_ERROR", message: "monotonic clock failed at startup" },
    });
    expect(events.at(-1)?.type).toBe("session_settled");
  });

  it("settles failed without stranding the Tool Call if the clock cannot resume after Approval", async () => {
    const { session, clock } = openTestSession({
      tools: [fakeWriteTool()],
      model: {
        turns: [toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } })],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");
    clock.monotonicMs = () => {
      throw new Error("monotonic clock failed after Approval");
    };

    const decision = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    const result = await session.result();
    const events = await collect(session.events());

    expect(decision.accepted).toBe(true);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "INTERNAL_ERROR", message: "monotonic clock failed after Approval" },
    });
    expect(events.at(-1)?.type).toBe("session_settled");
  });

  it("aborts a mutating Tool Call on duration exhaustion and reports possible partial changes", async () => {
    let executionSignal: AbortSignal | undefined;
    const slowWriter: ExecutableTool = {
      ...fakeTool({ name: "write", mutation: "mutating" }),
      execute(_prepared, { signal }) {
        executionSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ isError: false, content: "finished after abort" }),
            { once: true },
          );
        });
      },
    };
    const { session, clock } = openTestSession({
      approvalPolicy: "auto-approve",
      tools: [slowWriter],
      model: {
        turns: [toolCallTurn({ toolCallId: "call-1", name: "write", input: {} })],
      },
      limits: { maxDurationMs: 10 },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "tool_execution_started");
    clock.advance(10);
    const result = await session.result();
    const events = await collect(session.events());

    expect(executionSignal?.aborted).toBe(true);
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxDurationMs", limit: 10, observed: 10 },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "LIMIT_EXCEEDED" },
      partialChangesPossible: true,
    });
  });

  it("aborts Verification when active duration expires", async () => {
    let verificationSignal: AbortSignal | undefined;
    const kit = createTestKit({
      model: { turns: [textTurn("Done.")] },
      limits: { maxDurationMs: 10 },
    });
    const opened = openAgentSession({
      ...kit.config,
      verification: {
        verify(_candidate, { signal }) {
          verificationSignal = signal;
          return new Promise<VerificationDecision>((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve({ outcome: "succeeded", evidence: [] }),
              { once: true },
            );
          });
        },
      },
    });
    if (!opened.ok) throw new Error(`expected a session, got: ${opened.message}`);

    await opened.session.dispatch({ type: "start", task });
    await waitForEvent(opened.session, "verification_started");
    kit.clock.advance(10);
    const result = await opened.session.result();
    const events = await collect(opened.session.events());

    expect(verificationSignal?.aborted).toBe(true);
    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxDurationMs", limit: 10, observed: 10 },
    });
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
  });

  it("ends after maxConsecutiveRecoverableFailures and skips the rest of the batch", async () => {
    const { session } = openTestSession({
      tools: [throwingTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "explode", input: {} },
            { toolCallId: "call-2", name: "explode", input: {} },
            { toolCallId: "call-3", name: "explode", input: {} },
          ),
        ],
      },
      limits: { maxConsecutiveRecoverableFailures: 2 },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(events.find((event) => event.type === "runtime_limit_reached")).toMatchObject({
      data: { kind: "maxConsecutiveRecoverableFailures", limit: 2, observed: 2 },
    });
    expect(
      events
        .filter((event) => event.type === "tool_call_completed")
        .map((event) => [event.data.toolCallId, event.data.outcome]),
    ).toEqual([
      ["tool_call-1", "failed"],
      ["tool_call-2", "failed"],
      ["tool_call-3", "skipped"],
    ]);
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
  });

  it("does not increase the failure counter when Verification continues", async () => {
    let session!: AgentSession;
    let failuresAtNextTurn = -1;
    const testSession = openTestSession({
      tools: [throwingTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "explode", input: {} }),
          textTurn("First candidate."),
          () => {
            failuresAtNextTurn = session.snapshot().counters.consecutiveRecoverableFailures;
            return streamOf(async function* () {
              yield* textTurn("Second candidate.");
            });
          },
        ],
      },
      verification: [continueWith("Try again."), { outcome: "succeeded", evidence: [] }],
      limits: { maxConsecutiveRecoverableFailures: 2 },
    });
    session = testSession.session;

    await session.dispatch({ type: "start", task });
    const result = await session.result();

    expect(failuresAtNextTurn).toBe(1);
    expect(session.snapshot().counters.consecutiveRecoverableFailures).toBe(1);
    expect(result.outcome).toBe("succeeded");
  });

  it("allows multiple Verification continue cycles without a Verification-attempt limit", async () => {
    const { session, model } = openTestSession({
      model: {
        turns: [
          textTurn("Candidate 1."),
          textTurn("Candidate 2."),
          textTurn("Candidate 3."),
          textTurn("Candidate 4."),
          textTurn("Candidate 5."),
          textTurn("Final candidate."),
        ],
      },
      verification: [
        continueWith("Revise 1."),
        continueWith("Revise 2."),
        continueWith("Revise 3."),
        continueWith("Revise 4."),
        continueWith("Revise 5."),
      ],
      limits: { maxModelTurns: 10 },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(model.requests).toHaveLength(6);
    expect(events.filter((event) => event.type === "verification_started")).toHaveLength(6);
    expect(result.outcome).toBe("succeeded");
  });
});
