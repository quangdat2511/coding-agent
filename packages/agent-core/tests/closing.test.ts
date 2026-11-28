import { describe, expect, it } from "bun:test";
import type { Message } from "@coding-agent/ai";
import {
  type AgentRun,
  type ExecutableTool,
  openAgentRun,
  type RunEvent,
  type ToolOutcome,
} from "../src/index.ts";
import {
  abortIgnoringTool,
  collect,
  createTestKit,
  fakeTool,
  fakeWriteTool,
  openTestRun,
  sequentialIds,
  toolCallTurn,
  toolResultMessage,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const partialOutput = {
  isError: true,
  content: "1 pass\n[command cancelled]",
  error: { code: "SIGNAL", message: "cancelled" },
} as const satisfies ToolOutcome;

function returnsWhenAborted(name: string, outcome: ToolOutcome): ExecutableTool {
  return {
    ...fakeTool({ name, mutation: "mutating" }),
    execute: (_prepared, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(outcome), { once: true }),
      ),
  };
}

const completions = (events: readonly RunEvent[]) =>
  events.flatMap((event) => (event.type === "tool_call_completed" ? [event.data] : []));

function unanswered(transcript: readonly Message[]): string[] {
  const answered = new Set(
    transcript.flatMap(({ role, content }) =>
      role === "user" && Array.isArray(content)
        ? content.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : []))
        : [],
    ),
  );
  return transcript
    .flatMap(({ role, content }) => (role === "assistant" ? content : []))
    .flatMap((block) => (block.type === "tool_call" ? [block.toolCallId] : []))
    .filter((id) => !answered.has(id));
}

describe("closing every Tool Call", () => {
  it("closes the call of a pending Approval and the calls queued after it at cancellation", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
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
    await run.dispatch({ type: "cancel" });
    await run.result();
    const events = await collect(run.events());
    const { transcript } = run.snapshot();

    expect(completions(events)).toEqual([
      {
        toolCallId: "tool_call-1",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-1",
          toolName: "write",
          content: "write not run: CANCELLED",
          isError: true,
        },
      },
      {
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-2",
          toolName: "write",
          content: "write not run: CANCELLED",
          isError: true,
        },
      },
    ]);
    expect(transcript).toContainEqual(toolResultMessage("call-1", "write not run: CANCELLED"));
    expect(transcript).toContainEqual(toolResultMessage("call-2", "write not run: CANCELLED"));
    expect(unanswered(transcript)).toEqual([]);
  });

  it("closes a call that returns nothing within the Cancellation Grace Period as stopped", async () => {
    const stubborn = abortIgnoringTool();
    const { run, clock } = openTestRun({
      tools: [stubborn],
      approvalPolicy: "auto-approve",
      limits: { cancellationGraceMs: 25 },
      model: { turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })] },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "tool_execution_started");
    await run.dispatch({ type: "cancel" });
    clock.advance(25);
    const result = await run.result();
    stubborn.release();
    const events = await collect(run.events());

    expect(result).toMatchObject({ outcome: "failed", failure: { code: "CANCELLATION_TIMEOUT" } });
    expect(completions(events)).toEqual([
      {
        toolCallId: "tool_call-1",
        outcome: "failed",
        result: {
          toolCallId: "tool_call-1",
          toolName: "stubborn",
          content: "stubborn stopped without a result",
          isError: true,
        },
      },
    ]);
    expect(run.snapshot().transcript).toContainEqual(
      toolResultMessage("call-1", "stubborn stopped without a result"),
    );
    expect(unanswered(run.snapshot().transcript)).toEqual([]);
  });

  it("closes a call the duration limit stopped that returns nothing within the grace period", async () => {
    const stubborn = abortIgnoringTool();
    const { run, clock } = openTestRun({
      tools: [stubborn],
      approvalPolicy: "auto-approve",
      limits: { maxDurationMs: 10, cancellationGraceMs: 25 },
      model: { turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })] },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "tool_execution_started");
    clock.advance(10);
    clock.advance(25);
    const result = await run.result();
    stubborn.release();
    const events = await collect(run.events());

    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
    expect(completions(events)).toEqual([
      {
        toolCallId: "tool_call-1",
        outcome: "failed",
        result: {
          toolCallId: "tool_call-1",
          toolName: "stubborn",
          content: "stubborn stopped without a result",
          isError: true,
        },
      },
    ]);
    expect(unanswered(run.snapshot().transcript)).toEqual([]);
  });

  it("keeps the result a cancelled call returns within the Cancellation Grace Period", async () => {
    const { run, portCalls } = openTestRun({
      tools: [returnsWhenAborted("bash", partialOutput)],
      approvalPolicy: "auto-approve",
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "bash", input: {} },
            { toolCallId: "call-2", name: "bash", input: {} },
          ),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "tool_execution_started");
    await run.dispatch({ type: "cancel" });
    const result = await run.result();
    const events = await collect(run.events());

    expect(result.outcome).toBe("cancelled");
    expect(completions(events)).toEqual([
      {
        toolCallId: "tool_call-1",
        outcome: "cancelled",
        result: {
          toolCallId: "tool_call-1",
          toolName: "bash",
          content: partialOutput.content,
          isError: true,
          error: partialOutput.error,
          metadata: { durationMs: 0, approval: { status: "auto_approved", decidedBy: "policy" } },
        },
      },
      {
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "CANCELLED",
        result: {
          toolCallId: "tool_call-2",
          toolName: "bash",
          content: "bash not run: CANCELLED",
          isError: true,
        },
      },
    ]);
    expect(run.snapshot().transcript).toContainEqual(
      toolResultMessage("call-1", partialOutput.content),
    );
    expect(portCalls.filter((call) => call.startsWith("wording.closingToolResult"))).toHaveLength(
      1,
    );
    expect(unanswered(run.snapshot().transcript)).toEqual([]);
  });

  it("keeps the result a call stopped by the duration limit returns within the grace period", async () => {
    const { run, clock } = openTestRun({
      tools: [returnsWhenAborted("bash", partialOutput)],
      approvalPolicy: "auto-approve",
      limits: { maxDurationMs: 10 },
      model: { turns: [toolCallTurn({ toolCallId: "call-1", name: "bash", input: {} })] },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "tool_execution_started");
    clock.advance(10);
    const result = await run.result();
    const events = await collect(run.events());

    expect(result).toMatchObject({ outcome: "failed", failure: { code: "LIMIT_EXCEEDED" } });
    expect(completions(events)).toEqual([
      {
        toolCallId: "tool_call-1",
        outcome: "failed",
        result: {
          toolCallId: "tool_call-1",
          toolName: "bash",
          content: partialOutput.content,
          isError: true,
          error: partialOutput.error,
          metadata: { durationMs: 10, approval: { status: "auto_approved", decidedBy: "policy" } },
        },
      },
    ]);
    expect(run.snapshot().transcript).toContainEqual(
      toolResultMessage("call-1", partialOutput.content),
    );
    expect(unanswered(run.snapshot().transcript)).toEqual([]);
  });
});

describe("closing the Tool Calls of an Assistant Message the run never queued", () => {
  const twoCalls = toolCallTurn(
    { toolCallId: "call-1", name: "first", input: {} },
    { toolCallId: "call-2", name: "second", input: {} },
  );

  function openWithFailingIds(failsOn: (toolCallIdRequest: number) => boolean): AgentRun {
    const kit = createTestKit({
      tools: [fakeTool({ name: "first" }), fakeTool({ name: "second" })],
      model: { turns: [twoCalls] },
    });
    const ids = sequentialIds();
    let requests = 0;
    const opened = openAgentRun({
      ...kit.config,
      ids: {
        next(kind) {
          if (kind === "tool_call" && failsOn(++requests)) throw new Error("id source failed");
          return ids.next(kind);
        },
      },
    });
    if (!opened.ok) throw new Error(`expected a run, got: ${opened.message}`);
    return opened.run;
  }

  const queued = (events: readonly RunEvent[]) =>
    events.flatMap((event) => (event.type === "tool_call_queued" ? [event.data] : []));

  it("queues, skips and closes each call when the run ends before the first tool_call_queued", async () => {
    const run = openWithFailingIds((request) => request === 1);

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());
    const messageCompleted = events.findIndex(
      (event) => event.type === "assistant_message_completed",
    );

    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "INTERNAL_ERROR", message: "id source failed" },
    });
    expect(events.slice(messageCompleted).map(({ type }) => type)).toEqual([
      "assistant_message_completed",
      "tool_call_queued",
      "tool_call_queued",
      "tool_call_completed",
      "tool_call_completed",
      "model_turn_completed",
      "run_settled",
    ]);
    expect(queued(events)).toEqual([
      {
        modelTurnId: "model_turn-1",
        queueIndex: 0,
        toolCall: { id: "tool_call-1", providerId: "call-1", name: "first", arguments: "{}" },
      },
      {
        modelTurnId: "model_turn-1",
        queueIndex: 1,
        toolCall: { id: "tool_call-2", providerId: "call-2", name: "second", arguments: "{}" },
      },
    ]);
    expect(completions(events)).toEqual([
      {
        toolCallId: "tool_call-1",
        outcome: "skipped",
        reason: "INTERNAL_ERROR",
        result: {
          toolCallId: "tool_call-1",
          toolName: "first",
          content: "first not run: INTERNAL_ERROR",
          isError: true,
        },
      },
      {
        toolCallId: "tool_call-2",
        outcome: "skipped",
        reason: "INTERNAL_ERROR",
        result: {
          toolCallId: "tool_call-2",
          toolName: "second",
          content: "second not run: INTERNAL_ERROR",
          isError: true,
        },
      },
    ]);
    expect(unanswered(run.snapshot().transcript)).toEqual([]);
  });

  it("names each call by its Model Turn and place when the id source keeps failing", async () => {
    const run = openWithFailingIds(() => true);

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());

    expect(queued(events).map(({ toolCall }) => toolCall.id)).toEqual([
      "model_turn-1/tool_call/0",
      "model_turn-1/tool_call/1",
    ]);
    expect(completions(events)).toMatchObject([
      { toolCallId: "model_turn-1/tool_call/0", outcome: "skipped", reason: "INTERNAL_ERROR" },
      { toolCallId: "model_turn-1/tool_call/1", outcome: "skipped", reason: "INTERNAL_ERROR" },
    ]);
    expect(run.snapshot().transcript).toContainEqual(
      toolResultMessage("call-1", "first not run: INTERNAL_ERROR"),
    );
    expect(unanswered(run.snapshot().transcript)).toEqual([]);
  });
});
