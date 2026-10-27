import { describe, expect, it } from "bun:test";
import type { UserMessage } from "@coding-agent/ai";
import type { AgentState, ExecutableTool } from "../src/index.ts";
import {
  collect,
  fakeTool,
  fakeWorkspace,
  fakeWriteTool,
  openTestSession,
  resultOf,
  textTurn,
  toolCallTurn,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const toolResultMessage = (toolCallId: string, content: string, isError: boolean): UserMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId, content, isError }],
});

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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));

    const approvalResult = await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
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
    });

    expect(result).toMatchObject({
      outcome: "succeeded",
      workspaceChanged: true,
    });
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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    await new Promise((resolve) => setTimeout(resolve, 10));
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

  it("produces an APPROVAL_DENIED error Tool Result when the user denies, and the loop continues to the next call", async () => {
    const { session, model } = openTestSession({
      tools: [fakeTool(), fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "echo", input: {} },
          ),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
      reason: "too risky",
    });
    const result = await session.result();
    const events = await collect(session.events());

    // Check denied Tool Result
    const deniedResult = resultOf(events, "tool_call-1");
    expect(deniedResult).toEqual({
      toolCallId: "tool_call-1",
      toolName: "write",
      content: "Approval denied: too risky",
      isError: true,
      error: { code: "APPROVAL_DENIED", message: "Approval denied: too risky" },
      metadata: {
        durationMs: 0,
        approval: { status: "denied", decidedBy: "user", reason: "too risky" },
      },
    });

    // Check the denied call has outcome "denied"
    const denied = events.find(
      (event) => event.type === "tool_call_completed" && event.data.toolCallId === "tool_call-1",
    );
    expect(denied?.data).toMatchObject({ outcome: "denied" });

    // The next call (echo) should have been executed
    const echoResult = resultOf(events, "tool_call-2");
    expect(echoResult?.isError).toBe(false);

    // The model gets both tool results
    expect(model.requests[1]?.context.messages.slice(2)).toEqual([
      toolResultMessage("call-1", "Approval denied: too risky", true),
      toolResultMessage("call-2", "ok", false),
    ]);

    expect(result).toMatchObject({
      outcome: "succeeded",
      workspaceChanged: false,
      partialChangesPossible: false,
    });
  });

  it("self-transitions awaiting_approval when the user denies and the next queued call also requires Approval", async () => {
    const { session } = openTestSession({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "write", input: { path: "src/b.ts" } },
          ),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Deny the first call
    expect(session.snapshot().phase).toBe("awaiting_approval");
    expect(session.snapshot()).toMatchObject({
      toolCall: { id: "tool_call-1", name: "write" },
      approval: { approvalId: "approval-1" },
    });

    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The session should now be awaiting approval for the second call
    expect(session.snapshot().phase).toBe("awaiting_approval");
    expect(session.snapshot()).toMatchObject({
      toolCall: { id: "tool_call-2", name: "write" },
      approval: { approvalId: "approval-2", summary: "write src/b.ts" },
    });

    // Allow the second call so the session can settle
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-2",
      decision: "allow",
    });
    const result = await session.result();
    expect(result.outcome).toBe("succeeded");
  });

  it("transitions from awaiting_approval to executing_tool when the user denies and the next call is read-only", async () => {
    let executingState: AgentState | undefined;
    const echo: ExecutableTool = {
      ...fakeTool({ name: "echo" }),
      async execute() {
        executingState = session.snapshot();
        return { isError: false, content: "echoed" };
      },
    };
    const { session } = openTestSession({
      tools: [fakeWriteTool(), echo],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-2", name: "echo", input: {} },
          ),
          textTurn("Fixed it."),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });
    const result = await session.result();

    expect(executingState).toMatchObject({
      phase: "executing_tool",
      toolCall: { id: "tool_call-2", name: "echo" },
      queuedToolCalls: [],
    });
    expect(result.outcome).toBe("succeeded");
  });

  it("transitions from awaiting_approval to streaming_model when the user denies and no queued call remains", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "deny",
    });
    const result = await session.result();
    const events = await collect(session.events());

    // The model receives the denied result and tries again
    expect(events.filter((event) => event.type === "model_turn_started")).toHaveLength(2);
    expect(result.outcome).toBe("succeeded");
  });

  it("keeps the state in executing_tool with the next call during its prepare, between two calls in a batch", async () => {
    let stateAtPrepare: AgentState | undefined;
    const inspect: ExecutableTool = {
      ...fakeTool({ name: "inspect" }),
      async prepare(input) {
        stateAtPrepare = session.snapshot();
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
      queuedToolCalls: [],
    });
  });
});
