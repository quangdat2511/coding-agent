import { describe, expect, it } from "bun:test";
import type { AgentState, ExecutableTool, PrepareOutcome, ToolResult } from "../src/index.ts";
import {
  collect,
  fakeTool,
  fakeWorkspace,
  fakeWriteTool,
  objective,
  openTestRun,
  resultOf,
  textTurn,
  toolCallMessage,
  toolCallTurn,
  toolResultMessage,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const expectedDeniedResult = (
  toolCallId: string,
  toolName: string,
  reason?: string,
): ToolResult => {
  const message = reason ?? "approval denied by user";
  return {
    toolCallId,
    toolName,
    content: reason === undefined ? message : `approval denied by user: ${reason}`,
    isError: true,
    error: {
      code: "APPROVAL_DENIED",
      message,
    },
    metadata: {
      durationMs: 0,
      approval: {
        status: "denied",
        decidedBy: "user",
        ...(reason === undefined ? {} : { reason }),
      },
    },
  };
};

describe("waiting for Approval under the ask policy", () => {
  it("enters awaiting_approval and emits approval_requested with the correct identifiers, summary, and policy", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    expect(run.snapshot()).toMatchObject({
      phase: "awaiting_approval",
      modelTurn: { modelTurnId: "model_turn-1", index: 0 },
      toolCall: { id: "tool_call-1", providerId: "call-1", name: "write" },
      queuedToolCalls: [],
      approval: {
        approvalId: "approval-1",
        summary: "write src/a.ts",
        policy: "ask",
      },
    });

    // Allow so the run can settle, then verify events
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    await run.result();

    const events = await collect(run.events());
    const requested = events.find((event) => event.type === "approval_requested");
    expect(requested?.data).toEqual({
      approvalId: "approval-1",
      toolCallId: "tool_call-1",
      summary: "write src/a.ts",
      policy: "ask",
    });
  });

  it("resolves the Approval with decidedBy user, moves to executing_tool, and records the decision in the Tool Result metadata", async () => {
    let executingState: AgentState | undefined;
    const write: ExecutableTool = {
      ...fakeWriteTool(),
      async execute() {
        executingState = run.snapshot();
        return { isError: false, content: "ok" };
      },
    };
    const { run } = openTestRun({
      tools: [write],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const approvalResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
      reason: "approved for testing",
    });
    expect(approvalResult).toMatchObject({ accepted: true });

    const result = await run.result();
    const events = await collect(run.events());

    // Check approval_resolved event
    const resolved = events.find((event) => event.type === "approval_resolved");
    expect(resolved?.data).toEqual({
      approvalId: "approval-1",
      toolCallId: "tool_call-1",
      status: "allowed",
      decidedBy: "user",
      reason: "approved for testing",
    });

    // Check the state was executing_tool during execute
    expect(executingState).toMatchObject({
      phase: "executing_tool",
      toolCall: { id: "tool_call-1" },
      workspaceChanged: true,
    });

    // Check the Tool Result includes the approval metadata
    const toolResult = resultOf(events, "tool_call-1");
    expect(toolResult?.metadata?.approval).toEqual({
      status: "allowed",
      decidedBy: "user",
      reason: "approved for testing",
    });

    expect(result).toMatchObject({
      outcome: "succeeded",
      workspaceChanged: true,
    });
  });

  it("immediately transitions to executing_tool upon dispatching an allow decision", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const commandResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    // State snapshot must immediately reflect executing_tool, not awaiting_approval
    expect(run.snapshot().phase).toBe("executing_tool");

    const result = await run.result();
    expect(result.outcome).toBe("succeeded");
  });

  it("rejects a resolve_approval naming a different approvalId as STALE_APPROVAL", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const staleResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "wrong-id",
      decision: "allow",
    });
    expect(staleResult).toMatchObject({
      accepted: false,
      code: "STALE_APPROVAL",
    });

    // Clean up: allow with the correct id
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    await run.result();
  });

  it("rejects a resolve_approval with no Approval pending as INVALID_STATE", async () => {
    const { run } = openTestRun({
      model: {
        turns: [textTurn("Done.")],
      },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    const noApproval = await run.dispatch({
      type: "resolve_approval",
      approvalId: "any-id",
      decision: "allow",
    });
    expect(noApproval).toMatchObject({
      accepted: false,
      code: "INVALID_STATE",
    });
  });

  it("never enters awaiting_approval for a read-only call under the ask policy", async () => {
    const { run } = openTestRun({
      tools: [fakeTool({ name: "lookup" })],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "lookup", input: {} }),
          textTurn("Found it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());
    const types = events.map(({ type }) => type);

    expect(types).toContain("tool_execution_started");
    expect(types).not.toContain("approval_requested");
    expect(types).not.toContain("approval_resolved");
    expect(result.outcome).toBe("succeeded");
  });

  it("produces an error Tool Result rather than a mutation when a path becomes invalid during the approval wait", async () => {
    const workspace = fakeWorkspace();
    let checks = 0;
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      workspace: {
        ...workspace,
        async resolveForCreate(input) {
          checks += 1;
          return checks === 1
            ? workspace.resolveForCreate(input)
            : { ok: false, code: "PATH_OUTSIDE_REPO", message: `${input} is a symbolic link` };
        },
      },
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    await run.result();

    const events = await collect(run.events());
    expect(events.find((event) => event.type === "tool_call_completed")?.data).toMatchObject({
      toolCallId: "tool_call-1",
      outcome: "failed",
      result: {
        isError: true,
        error: { code: "PATH_OUTSIDE_REPO", message: "/repo/src/a.ts is a symbolic link" },
      },
    });
  });

  it("resolves a denial with decidedBy user, produces an APPROVAL_DENIED Tool Result without executing, and returns to streaming with none remaining", async () => {
    let executed = false;
    const write: ExecutableTool = {
      ...fakeWriteTool(),
      async execute() {
        executed = true;
        return { isError: false, content: "ok" };
      },
    };
    const { run, model } = openTestRun({
      tools: [write],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Understood, I will adapt without modifying that file."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const commandResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "do not modify this file",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    // When denied with none remaining, the run returns directly to streaming_model
    expect(run.snapshot().phase).toBe("streaming_model");

    const result = await run.result();
    expect(result.outcome).toBe("succeeded");
    expect(executed).toBe(false);

    const events = await collect(run.events());

    // 1. Approval was resolved as denied with decidedBy: "user" and the reason
    const resolved = events.find((event) => event.type === "approval_resolved");
    expect(resolved?.data).toEqual({
      approvalId: "approval-1",
      toolCallId: "tool_call-1",
      status: "denied",
      decidedBy: "user",
      reason: "do not modify this file",
    });

    // 2. The denied call has no execution-started event
    const executionStarted = events.find((event) => event.type === "tool_execution_started");
    expect(executionStarted).toBeUndefined();

    // 3. Tool Result carries APPROVAL_DENIED, the reason, durationMs 0, and approval metadata
    const completed = events.find((event) => event.type === "tool_call_completed");
    expect(completed?.data).toMatchObject({
      toolCallId: "tool_call-1",
      outcome: "denied",
    });

    const toolResult = resultOf(events, "tool_call-1");
    expect(toolResult).toEqual(
      expectedDeniedResult("tool_call-1", "write", "do not modify this file"),
    );

    // 4. Next Model Turn receives the denial feedback so the model can adapt
    expect(model.requests[1]?.context.messages).toEqual([
      objective,
      toolCallMessage({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
      toolResultMessage("call-1", "approval denied by user: do not modify this file"),
    ]);

    // 5. Workspace flags were untouched
    expect(result.workspaceChanged).toBe(false);
    expect(result.partialChangesPossible).toBe(false);
  });

  it("uses the default reason when a denial does not provide one", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Understood."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const commandResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    await run.result();
    const events = await collect(run.events());
    const toolResult = resultOf(events, "tool_call-1");

    expect(toolResult).toEqual(expectedDeniedResult("tool_call-1", "write"));
  });

  it("uses the default reason when a denial provides a blank reason", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Understood."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const commandResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "   ",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    await run.result();
    const events = await collect(run.events());
    const toolResult = resultOf(events, "tool_call-1");

    expect(toolResult).toEqual(expectedDeniedResult("tool_call-1", "write"));

    const resolved = events.find((event) => event.type === "approval_resolved");
    expect(resolved?.data).toEqual({
      approvalId: "approval-1",
      toolCallId: "tool_call-1",
      status: "denied",
      decidedBy: "user",
    });
  });

  it("rejects an already resolved approval as INVALID_STATE while preparing and as STALE_APPROVAL when another approval is pending", async () => {
    const deferredPrepare = Promise.withResolvers<PrepareOutcome>();
    const baseWrite = fakeWriteTool();
    let prepareCount = 0;
    const write: typeof baseWrite = {
      ...baseWrite,
      async prepare(input, ctx) {
        prepareCount++;
        if (prepareCount === 2) {
          return deferredPrepare.promise;
        }
        return baseWrite.prepare(input, ctx);
      },
    };

    const { run } = openTestRun({
      tools: [write],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "write", input: { path: "src/b.ts" } },
          ),
          textTurn("Done."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    const req1 = await waitForEvent(run, "approval_requested");

    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });

    // While call 2 is still preparing in executing_tool, no Approval is pending
    const invalidResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    expect(invalidResult).toMatchObject({
      accepted: false,
      code: "INVALID_STATE",
    });

    // Release call 2's prepare
    deferredPrepare.resolve({
      ok: true,
      prepared: { input: { path: "src/b.ts" }, paths: [], summary: "write src/b.ts" },
    });

    const req2 = await waitForEvent(run, "approval_requested", req1.sequence);
    expect(req2.data.approvalId).toBe("approval-2");

    // Once approval-2 is pending, dispatching the old approval-1 returns STALE_APPROVAL
    const staleResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    expect(staleResult).toMatchObject({
      accepted: false,
      code: "STALE_APPROVAL",
    });

    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-2",
      decision: "allow",
    });

    const result = await run.result();
    expect(result.outcome).toBe("succeeded");
  });

  it("does not re-execute preflight when a denied call is followed by a call that fails preflight", async () => {
    let call2PrepareCount = 0;
    const inspect: ExecutableTool = {
      ...fakeTool({ name: "failing_mutating" }),
      mutation: "mutating",
      async prepare() {
        call2PrepareCount++;
        return { ok: false, code: "SCHEMA_VIOLATION", message: "invalid payload" };
      },
    };

    const { run } = openTestRun({
      tools: [fakeWriteTool(), inspect],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "failing_mutating", input: {} },
          ),
          textTurn("Done after failures."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });

    const result = await run.result();
    expect(result.outcome).toBe("succeeded");
    expect(call2PrepareCount).toBe(1);

    const events = await collect(run.events());
    expect(resultOf(events, "tool_call-1")?.error?.code).toBe("APPROVAL_DENIED");
    expect(resultOf(events, "tool_call-2")?.error?.code).toBe("SCHEMA_VIOLATION");
  });

  it("moves from execution to awaiting_approval with a fresh request when a denied call is followed by another call needing Approval", async () => {
    let phaseDuringCall2Prepare: string | undefined;
    const baseWrite = fakeWriteTool();
    let prepareCount = 0;
    const write: typeof baseWrite = {
      ...baseWrite,
      async prepare(input, ctx) {
        prepareCount++;
        if (prepareCount === 2) {
          phaseDuringCall2Prepare = run.snapshot().phase;
        }
        return baseWrite.prepare(input, ctx);
      },
    };

    const { run } = openTestRun({
      tools: [write],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "write", input: { path: "src/b.ts" } },
          ),
          textTurn("Completed turn with second file written."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });

    // First call requests approval
    const req1 = await waitForEvent(run, "approval_requested");
    expect(req1.data).toMatchObject({
      approvalId: "approval-1",
      toolCallId: "tool_call-1",
      summary: "write src/a.ts",
    });

    // Deny the first call
    const denyResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "do not touch a.ts",
    });
    expect(denyResult).toMatchObject({ accepted: true });

    // Second call requests a fresh approval and moves to awaiting_approval
    const req2 = await waitForEvent(run, "approval_requested", req1.sequence);
    expect(req2.data).toMatchObject({
      approvalId: "approval-2",
      toolCallId: "tool_call-2",
      summary: "write src/b.ts",
    });

    // Verify call 2 prepared while in executing_tool, then entered awaiting_approval
    expect(phaseDuringCall2Prepare).toBe("executing_tool");

    expect(run.snapshot()).toMatchObject({
      phase: "awaiting_approval",
      toolCall: { id: "tool_call-2", providerId: "call-2", name: "write" },
      queuedToolCalls: [],
      approval: {
        approvalId: "approval-2",
        summary: "write src/b.ts",
        policy: "ask",
      },
    });

    // Allow the second call so the run settles
    const allowResult = await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-2",
      decision: "allow",
    });
    expect(allowResult).toMatchObject({ accepted: true });

    const result = await run.result();
    expect(result.outcome).toBe("succeeded");

    const events = await collect(run.events());

    // Call 1 was denied and has no execution-started event
    const executionEvents = events.filter((event) => event.type === "tool_execution_started");
    expect(executionEvents).toHaveLength(1);
    expect(executionEvents[0]?.data.toolCallId).toBe("tool_call-2");

    expect(resultOf(events, "tool_call-1")?.error?.code).toBe("APPROVAL_DENIED");
    expect(resultOf(events, "tool_call-2")?.isError).toBe(false);
  });

  it("moves to execution when a denied call is followed by an automatically allowed call", async () => {
    let lookupExecuted = false;
    const lookup: ExecutableTool = {
      ...fakeTool({ name: "lookup" }),
      async execute() {
        lookupExecuted = true;
        return { isError: false, content: "file content" };
      },
    };

    const { run } = openTestRun({
      tools: [fakeWriteTool(), lookup],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "lookup", input: {} },
          ),
          textTurn("Completed after reading."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    const req = await waitForEvent(run, "approval_requested");
    expect(req.data.toolCallId).toBe("tool_call-1");

    // Deny the mutating call
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "skip write",
    });

    // The run should automatically execute the read-only call without another approval request
    const result = await run.result();
    expect(result.outcome).toBe("succeeded");
    expect(lookupExecuted).toBe(true);

    const events = await collect(run.events());
    const approvalRequests = events.filter((event) => event.type === "approval_requested");
    expect(approvalRequests).toHaveLength(1);

    const executionStarted = events.find((event) => event.type === "tool_execution_started");
    expect(executionStarted?.data.toolCallId).toBe("tool_call-2");

    expect(resultOf(events, "tool_call-1")?.error?.code).toBe("APPROVAL_DENIED");
    expect(resultOf(events, "tool_call-2")?.content).toBe("file content");
  });

  it("moves from execution to awaiting_approval when a completed call is followed by one needing Approval", async () => {
    let phaseDuringCall2Prepare: string | undefined;
    const baseWrite = fakeWriteTool();
    const write: typeof baseWrite = {
      ...baseWrite,
      async prepare(input, ctx) {
        phaseDuringCall2Prepare = run.snapshot().phase;
        return baseWrite.prepare(input, ctx);
      },
    };

    const { run } = openTestRun({
      tools: [fakeTool({ name: "lookup" }), write],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "lookup", input: {} },
            { toolCallId: "call-2", name: "write", input: { path: "src/a.ts" } },
          ),
          textTurn("All done."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });

    // Lookup completes automatically in executing_tool, and write prepares in executing_tool
    const req = await waitForEvent(run, "approval_requested");
    expect(req.data).toMatchObject({
      approvalId: "approval-1",
      toolCallId: "tool_call-2",
      summary: "write src/a.ts",
    });

    // Write moved into awaiting_approval
    expect(run.snapshot().phase).toBe("awaiting_approval");

    // Allow write to finish
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    const result = await run.result();
    expect(result.outcome).toBe("succeeded");

    // Verify call 2 prepared while in executing_tool, then moved to awaiting_approval
    expect(phaseDuringCall2Prepare).toBe("executing_tool");
  });

  it("keeps the state in executing_tool with the next call during its prepare, between calls in a batch", async () => {
    let stateAtPrepare: AgentState | undefined;
    const inspect: ExecutableTool = {
      ...fakeTool({ name: "inspect" }),
      async prepare(input) {
        stateAtPrepare ??= run.snapshot();
        return {
          ok: true,
          prepared: { input, paths: [], summary: `inspect ${JSON.stringify(input)}` },
        };
      },
    };
    const { run } = openTestRun({
      approvalPolicy: "auto-approve",
      tools: [fakeWriteTool(), inspect],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "inspect", input: {} },
            { toolCallId: "call-3", name: "inspect", input: {} },
          ),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(stateAtPrepare).toMatchObject({
      phase: "executing_tool",
      toolCall: { id: "tool_call-2", name: "inspect" },
      queuedToolCalls: [{ id: "tool_call-3" }],
    });
  });

  it("increments consecutive recoverable failures on denial and resets upon a successful call", async () => {
    let failuresObservedAtCall2Req = 0;
    let failuresObservedAtCall3Req = 0;

    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "write", input: { path: "src/b.ts" } },
            { toolCallId: "call-3", name: "write", input: { path: "src/c.ts" } },
          ),
          textTurn("Finished after call 3."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });

    // Call 1
    const req1 = await waitForEvent(run, "approval_requested");
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });

    // Call 2
    const req2 = await waitForEvent(run, "approval_requested", req1.sequence);
    failuresObservedAtCall2Req = run.snapshot().counters.consecutiveRecoverableFailures;

    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-2",
      decision: "deny",
    });

    // Call 3
    const req3 = await waitForEvent(run, "approval_requested", req2.sequence);
    expect(req3.data.toolCallId).toBe("tool_call-3");
    failuresObservedAtCall3Req = run.snapshot().counters.consecutiveRecoverableFailures;

    // Allow Call 3
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-3",
      decision: "allow",
    });

    const result = await run.result();
    expect(result.outcome).toBe("succeeded");

    // Denials incremented consecutive recoverable failures
    expect(failuresObservedAtCall2Req).toBe(1);
    expect(failuresObservedAtCall3Req).toBe(2);

    // After call 3 succeeded, the consecutive counter reset to 0
    expect(run.snapshot().counters.consecutiveRecoverableFailures).toBe(0);
  });

  it("emits no approval events and skips the call when commit throws during approval request", async () => {
    let throwClock = false;
    const original = fakeWriteTool();
    const tool: typeof original = {
      ...original,
      async prepare(input, ctx) {
        throwClock = true;
        return original.prepare(input, ctx);
      },
    };

    const { run, clock } = openTestRun({
      tools: [tool],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("done"),
        ],
      },
    });

    const originalNow = clock.now;
    clock.now = () => {
      if (throwClock) {
        throw new Error("clock failed during approval request");
      }
      return originalNow();
    };

    await run.dispatch({ type: "start", task });

    const result = await run.result();
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "INTERNAL_ERROR",
        message: "clock failed during approval request",
      },
    });

    const events = await collect(run.events());
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).not.toContain("approval_requested");
    expect(eventTypes).not.toContain("approval_resolved");

    const toolCompleted = events.find((event) => event.type === "tool_call_completed");
    expect(toolCompleted?.data).toEqual({
      toolCallId: "tool_call-1",
      outcome: "skipped",
      reason: "INTERNAL_ERROR",
    });
  });
});
