import { describe, expect, it } from "bun:test";
import type { AgentState, ExecutableTool, ToolResult } from "../src/index.ts";
import {
  collect,
  fakeTool,
  fakeWorkspace,
  fakeWriteTool,
  openTestSession,
  resultOf,
  textTurn,
  toolCallTurn,
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
    content: message,
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
    const { session } = openTestSession({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");

    expect(session.snapshot()).toMatchObject({
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

    // Allow so the session can settle, then verify events
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    await session.result();

    const events = await collect(session.events());
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
        executingState = session.snapshot();
        return { isError: false, content: "ok" };
      },
    };
    const { session } = openTestSession({
      tools: [write],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");

    const approvalResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
      reason: "approved for testing",
    });
    expect(approvalResult).toMatchObject({ accepted: true });

    const result = await session.result();
    const events = await collect(session.events());

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
    const { session } = openTestSession({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");

    const commandResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    // State snapshot must immediately reflect executing_tool, not awaiting_approval
    expect(session.snapshot().phase).toBe("executing_tool");

    const result = await session.result();
    expect(result.outcome).toBe("succeeded");
  });

  it("rejects a resolve_approval naming a different approvalId as STALE_APPROVAL", async () => {
    const { session } = openTestSession({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");

    const staleResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "wrong-id",
      decision: "allow",
    });
    expect(staleResult).toMatchObject({
      accepted: false,
      code: "STALE_APPROVAL",
    });

    // Clean up: allow with the correct id
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    await session.result();
  });

  it("rejects a resolve_approval with no Approval pending as INVALID_STATE", async () => {
    const { session } = openTestSession({
      model: {
        turns: [textTurn("Done.")],
      },
    });

    await session.dispatch({ type: "start", task });
    await session.result();

    const noApproval = await session.dispatch({
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
    const { session } = openTestSession({
      tools: [fakeTool({ name: "lookup" })],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "lookup", input: {} }),
          textTurn("Found it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());
    const types = events.map(({ type }) => type);

    expect(types).toContain("tool_execution_started");
    expect(types).not.toContain("approval_requested");
    expect(types).not.toContain("approval_resolved");
    expect(result.outcome).toBe("succeeded");
  });

  it("produces an error Tool Result rather than a mutation when a path becomes invalid during the approval wait", async () => {
    const workspace = fakeWorkspace();
    let checks = 0;
    const { session } = openTestSession({
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

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    await session.result();

    const events = await collect(session.events());
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
    const { session } = openTestSession({
      tools: [write],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Understood, I will adapt without modifying that file."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");

    const commandResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "do not modify this file",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    const result = await session.result();
    expect(result.outcome).toBe("succeeded");
    expect(executed).toBe(false);

    const events = await collect(session.events());

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

    // 4. Workspace flags were untouched
    expect(result.workspaceChanged).toBe(false);
    expect(result.partialChangesPossible).toBe(false);
  });

  it("uses the default reason when a denial does not provide one", async () => {
    const { session } = openTestSession({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Understood."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await waitForEvent(session, "approval_requested");

    const commandResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });
    expect(commandResult).toMatchObject({ accepted: true });

    await session.result();
    const events = await collect(session.events());
    const toolResult = resultOf(events, "tool_call-1");

    expect(toolResult).toEqual(expectedDeniedResult("tool_call-1", "write"));
  });

  it("stays in awaiting_approval with a fresh request when a denied call is followed by another call needing Approval", async () => {
    let phaseDuringCall2Prepare: string | undefined;
    const baseWrite = fakeWriteTool();
    let prepareCount = 0;
    const write: typeof baseWrite = {
      ...baseWrite,
      async prepare(input, ctx) {
        prepareCount++;
        if (prepareCount === 2) {
          phaseDuringCall2Prepare = session.snapshot().phase;
        }
        return baseWrite.prepare(input, ctx);
      },
    };

    const { session } = openTestSession({
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

    await session.dispatch({ type: "start", task });

    // First call requests approval
    const req1 = await waitForEvent(session, "approval_requested");
    expect(req1.data).toMatchObject({
      approvalId: "approval-1",
      toolCallId: "tool_call-1",
      summary: "write src/a.ts",
    });

    // Deny the first call
    const denyResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "do not touch a.ts",
    });
    expect(denyResult).toMatchObject({ accepted: true });

    // Second call requests a fresh approval and stays in awaiting_approval
    const req2 = await waitForEvent(session, "approval_requested", req1.sequence);
    expect(req2.data).toMatchObject({
      approvalId: "approval-2",
      toolCallId: "tool_call-2",
      summary: "write src/b.ts",
    });

    // Verify call 2 prepared while in awaiting_approval (never entered executing_tool)
    expect(phaseDuringCall2Prepare).toBe("awaiting_approval");

    expect(session.snapshot()).toMatchObject({
      phase: "awaiting_approval",
      toolCall: { id: "tool_call-2", providerId: "call-2", name: "write" },
      queuedToolCalls: [],
      approval: {
        approvalId: "approval-2",
        summary: "write src/b.ts",
        policy: "ask",
      },
    });

    // Allow the second call so the session settles
    const allowResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-2",
      decision: "allow",
    });
    expect(allowResult).toMatchObject({ accepted: true });

    const result = await session.result();
    expect(result.outcome).toBe("succeeded");

    const events = await collect(session.events());

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

    const { session } = openTestSession({
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

    await session.dispatch({ type: "start", task });
    const req = await waitForEvent(session, "approval_requested");
    expect(req.data.toolCallId).toBe("tool_call-1");

    // Deny the mutating call
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "skip write",
    });

    // The session should automatically execute the read-only call without another approval request
    const result = await session.result();
    expect(result.outcome).toBe("succeeded");
    expect(lookupExecuted).toBe(true);

    const events = await collect(session.events());
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
        phaseDuringCall2Prepare = session.snapshot().phase;
        return baseWrite.prepare(input, ctx);
      },
    };

    const { session } = openTestSession({
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

    await session.dispatch({ type: "start", task });

    // Lookup completes automatically in executing_tool, and write prepares in executing_tool
    const req = await waitForEvent(session, "approval_requested");
    expect(req.data).toMatchObject({
      approvalId: "approval-1",
      toolCallId: "tool_call-2",
      summary: "write src/a.ts",
    });

    // Write moved into awaiting_approval
    expect(session.snapshot().phase).toBe("awaiting_approval");

    // Allow write to finish
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    const result = await session.result();
    expect(result.outcome).toBe("succeeded");

    // Verify call 2 prepared while in executing_tool, then moved to awaiting_approval
    expect(phaseDuringCall2Prepare).toBe("executing_tool");
  });

  it("keeps the state in executing_tool with the next call during its prepare, between calls in a batch", async () => {
    let stateAtPrepare: AgentState | undefined;
    const inspect: ExecutableTool = {
      ...fakeTool({ name: "inspect" }),
      async prepare(input) {
        stateAtPrepare ??= session.snapshot();
        return {
          ok: true,
          prepared: { input, paths: [], summary: `inspect ${JSON.stringify(input)}` },
        };
      },
    };
    const { session } = openTestSession({
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

    await session.dispatch({ type: "start", task });
    await session.result();

    expect(stateAtPrepare).toMatchObject({
      phase: "executing_tool",
      toolCall: { id: "tool_call-2", name: "inspect" },
      queuedToolCalls: [{ id: "tool_call-3" }],
    });
  });

  it("increments consecutive recoverable failures on denial and resets upon a successful call", async () => {
    let failuresObservedAtCall2Req = 0;
    let failuresObservedAtCall3Req = 0;

    const { session } = openTestSession({
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

    await session.dispatch({ type: "start", task });

    // Call 1
    const req1 = await waitForEvent(session, "approval_requested");
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });

    // Call 2
    const req2 = await waitForEvent(session, "approval_requested", req1.sequence);
    failuresObservedAtCall2Req = session.snapshot().counters.consecutiveRecoverableFailures;

    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-2",
      decision: "deny",
    });

    // Call 3
    const req3 = await waitForEvent(session, "approval_requested", req2.sequence);
    expect(req3.data.toolCallId).toBe("tool_call-3");
    failuresObservedAtCall3Req = session.snapshot().counters.consecutiveRecoverableFailures;

    // Allow Call 3
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-3",
      decision: "allow",
    });

    const result = await session.result();
    expect(result.outcome).toBe("succeeded");

    // Denials incremented consecutive recoverable failures
    expect(failuresObservedAtCall2Req).toBe(1);
    expect(failuresObservedAtCall3Req).toBe(2);

    // After call 3 succeeded, the consecutive counter reset to 0
    expect(session.snapshot().counters.consecutiveRecoverableFailures).toBe(0);
  });
});
