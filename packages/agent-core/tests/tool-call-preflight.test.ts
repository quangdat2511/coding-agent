import { describe, expect, it } from "bun:test";
import type { Message } from "@coding-agent/ai";
import { Type } from "typebox";
import type { ExecutableTool, PrepareOutcome, ToolErrorCode, ToolResult } from "../src/index.ts";
import {
  collect,
  fakeTool,
  fakeWriteTool,
  objective,
  openTestRun,
  resultOf,
  type ScriptedToolCall,
  textTurn,
  throwingTool,
  toolCallMessage,
  toolCallTurn,
  toolResultMessage,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const errorResult = (toolName: string, code: ToolErrorCode, message: string): ToolResult => ({
  toolCallId: "tool_call-1",
  toolName,
  content: message,
  isError: true,
  error: { code, message },
});

const unknownCalls = toolCallTurn(
  { toolCallId: "call-1", name: "frobnicate", input: {} },
  { toolCallId: "call-2", name: "transmogrify", input: { into: "tiger" } },
);

describe("resolving Tool Calls in preflight", () => {
  it("queues every call of a batch in model order before resolving the first", async () => {
    const { run } = openTestRun({
      model: { turns: [unknownCalls, textTurn("Fixed it.")] },
    });

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());
    const toolCallEvents = events.filter(
      (event) => event.type === "tool_call_queued" || event.type === "tool_call_completed",
    );

    expect(toolCallEvents.map(({ type, data }) => ({ type, data }))).toMatchObject([
      {
        type: "tool_call_queued",
        data: {
          modelTurnId: "model_turn-1",
          queueIndex: 0,
          toolCall: {
            id: "tool_call-1",
            providerId: "call-1",
            name: "frobnicate",
            arguments: "{}",
          },
        },
      },
      {
        type: "tool_call_queued",
        data: {
          modelTurnId: "model_turn-1",
          queueIndex: 1,
          toolCall: {
            id: "tool_call-2",
            providerId: "call-2",
            name: "transmogrify",
            arguments: '{"into":"tiger"}',
          },
        },
      },
      { type: "tool_call_completed", data: { toolCallId: "tool_call-1", outcome: "failed" } },
      { type: "tool_call_completed", data: { toolCallId: "tool_call-2", outcome: "failed" } },
    ]);
  });

  it("counts every queued call toward the run's Tool Calls", async () => {
    const { run } = openTestRun({
      model: { turns: [unknownCalls, textTurn("Fixed it.")] },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(run.snapshot().counters.toolCalls).toBe(2);
  });

  it("prepares each call only after the call before it has its Tool Result", async () => {
    let transcriptAtSecondPrepare: readonly Message[] = [];
    const inspect: ExecutableTool = {
      ...fakeTool({ name: "inspect" }),
      async prepare() {
        transcriptAtSecondPrepare = run.snapshot().transcript;
        return { ok: false, code: "NOT_FOUND", message: "nothing to inspect" };
      },
    };
    const { run } = openTestRun({
      tools: [fakeWriteTool(), inspect],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "write", input: { path: "../outside.ts" } },
            { toolCallId: "call-2", name: "inspect", input: {} },
          ),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(transcriptAtSecondPrepare.at(-1)).toEqual(
      toolResultMessage("call-1", "../outside.ts is outside the repository"),
    );
  });

  it("returns to streaming once every call resolves in preflight, sending their Tool Results in model order", async () => {
    const { run, model } = openTestRun({
      model: { turns: [unknownCalls, textTurn("Fixed it.")] },
    });

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());
    const queued = events.findIndex((event) => event.type === "tool_call_queued");

    expect(events.slice(queued, queued + 7).map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "tool_call_queued", data: expect.objectContaining({ queueIndex: 0 }) },
      { type: "tool_call_queued", data: expect.objectContaining({ queueIndex: 1 }) },
      {
        type: "tool_call_completed",
        data: expect.objectContaining({ toolCallId: "tool_call-1", outcome: "failed" }),
      },
      {
        type: "tool_call_completed",
        data: expect.objectContaining({ toolCallId: "tool_call-2", outcome: "failed" }),
      },
      {
        type: "model_turn_completed",
        data: {
          modelTurnId: "model_turn-1",
          outcome: "completed",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      {
        type: "model_turn_started",
        data: { modelTurnId: "model_turn-2", index: 1, model: expect.any(Object) },
      },
      {
        type: "assistant_message_started",
        data: { modelTurnId: "model_turn-2", messageId: "assistant_message-2" },
      },
    ]);
    expect(model.requests[1]?.context.messages).toEqual([
      objective,
      toolCallMessage(
        { toolCallId: "call-1", name: "frobnicate", input: {} },
        { toolCallId: "call-2", name: "transmogrify", input: { into: "tiger" } },
      ),
      toolResultMessage("call-1", 'unknown tool "frobnicate"; the available tools are echo'),
      toolResultMessage("call-2", 'unknown tool "transmogrify"; the available tools are echo'),
    ]);
  });

  it("rejects a call to an unknown tool with a NOT_FOUND error Tool Result and asks the model again", async () => {
    const call = { toolCallId: "call-1", name: "frobnicate", input: {} };
    const { run, model } = openTestRun({
      model: { turns: [toolCallTurn(call), textTurn("Fixed it.")] },
    });
    const unknown = 'unknown tool "frobnicate"; the available tools are echo';

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());

    expect(events.find((event) => event.type === "tool_call_completed")?.data).toEqual({
      toolCallId: "tool_call-1",
      outcome: "failed",
      result: errorResult("frobnicate", "NOT_FOUND", unknown),
    });
    expect(model.requests[1]?.context.messages).toEqual([
      objective,
      toolCallMessage(call),
      toolResultMessage("call-1", unknown),
    ]);
  });

  it("rejects malformed JSON arguments with a SCHEMA_VIOLATION error Tool Result, without preparing the call", async () => {
    const { run, portCalls } = openTestRun({
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "echo", arguments: '{"text": "hi"' }),
          textTurn("Fixed it."),
        ],
      },
    });
    const invalidJson = expect.stringMatching(/^the arguments for echo are not valid JSON: /);

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(resultOf(await collect(run.events()), "tool_call-1")).toEqual(
      errorResult("echo", "SCHEMA_VIOLATION", invalidJson),
    );
    expect(portCalls).not.toContain("tool.prepare(echo)");
  });

  it.each<{ name: string; call: ScriptedToolCall; problem: string }>([
    {
      name: "a field has the wrong type",
      call: { toolCallId: "call-1", name: "read", input: { path: 42 } },
      problem: "arguments/path must be string",
    },
    {
      name: "a required field is missing",
      call: { toolCallId: "call-1", name: "read", input: {} },
      problem: "arguments must have required properties path",
    },
    {
      name: "the arguments are not an object",
      call: { toolCallId: "call-1", name: "read", arguments: '["src/a.ts"]' },
      problem: "arguments must be object",
    },
  ])(
    "rejects the call with a SCHEMA_VIOLATION error Tool Result, without preparing it, when $name",
    async ({ call, problem }) => {
      const { run, portCalls } = openTestRun({
        tools: [fakeTool({ name: "read", parameters: Type.Object({ path: Type.String() }) })],
        model: { turns: [toolCallTurn(call), textTurn("Fixed it.")] },
      });

      await run.dispatch({ type: "start", task });
      await run.result();

      expect(resultOf(await collect(run.events()), "tool_call-1")).toEqual(
        errorResult("read", "SCHEMA_VIOLATION", `Schema Validation failed for read: ${problem}`),
      );
      expect(portCalls).not.toContain("tool.prepare(read)");
    },
  );

  it("rejects the call with the code and message of a prepare that refuses it, such as a path outside the repository", async () => {
    const { run, portCalls } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "../outside.ts" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(resultOf(await collect(run.events()), "tool_call-1")).toEqual(
      errorResult("write", "PATH_OUTSIDE_REPO", "../outside.ts is outside the repository"),
    );
    expect(portCalls).toContain("workspace.resolveForCreate(../outside.ts)");
  });

  it.each(["throw", "reject"] as const)(
    "rejects the call with a recoverable TOOL_INTERNAL_ERROR, without a stack trace, when prepare %ss",
    async (failure) => {
      const { run } = openTestRun({
        tools: [throwingTool({ phase: "prepare", failure })],
        model: {
          turns: [
            toolCallTurn({ toolCallId: "call-1", name: "explode", input: {} }),
            textTurn("Fixed it."),
          ],
        },
      });
      const sanitized =
        "explode failed unexpectedly while preparing the call: explode failed during prepare";

      await run.dispatch({ type: "start", task });
      const { outcome } = await run.result();

      expect(resultOf(await collect(run.events()), "tool_call-1")).toEqual(
        errorResult("explode", "TOOL_INTERNAL_ERROR", sanitized),
      );
      expect(outcome).toBe("succeeded");
    },
  );

  it("rejects the call with a recoverable TOOL_INTERNAL_ERROR, without preparing it, when the tool's schema cannot be evaluated", async () => {
    const { run, portCalls } = openTestRun({
      tools: [
        fakeTool({
          name: "grep",
          parameters: Type.Object({ pattern: Type.String({ pattern: "(" }) }),
        }),
      ],
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "grep", input: { pattern: "TODO" } }),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    const { outcome } = await run.result();

    expect(resultOf(await collect(run.events()), "tool_call-1")?.error).toEqual({
      code: "TOOL_INTERNAL_ERROR",
      message: expect.stringMatching(/^the parameter schema of grep could not be evaluated: /),
    });
    expect(outcome).toBe("succeeded");
    expect(portCalls).not.toContain("tool.prepare(grep)");
  });

  it.each<{ name: string; outcome: unknown }>([
    { name: "nothing", outcome: undefined },
    {
      name: "a code outside the tool error codes",
      outcome: { ok: false, code: "EXPLODED", message: "boom" },
    },
    {
      name: "an Error in place of a message",
      outcome: { ok: false, code: "NOT_FOUND", message: new Error("boom") },
    },
    { name: "success without a prepared call", outcome: { ok: true } },
    {
      name: "a prepared call without a summary",
      outcome: { ok: true, prepared: { input: {}, paths: [] } },
    },
  ])(
    "rejects the call with a recoverable TOOL_INTERNAL_ERROR when prepare returns $name",
    async ({ outcome }) => {
      const broken: ExecutableTool = {
        ...fakeTool({ name: "broken" }),
        prepare: async () => outcome as PrepareOutcome,
      };
      const { run } = openTestRun({
        tools: [broken],
        model: {
          turns: [
            toolCallTurn({ toolCallId: "call-1", name: "broken", input: {} }),
            textTurn("Fixed it."),
          ],
        },
      });

      await run.dispatch({ type: "start", task });
      const settled = await run.result();

      expect(resultOf(await collect(run.events()), "tool_call-1")?.error).toEqual({
        code: "TOOL_INTERNAL_ERROR",
        message:
          "broken failed unexpectedly while preparing the call: prepare returned an unusable outcome",
      });
      expect(settled.outcome).toBe("succeeded");
    },
  );

  it("counts each error Tool Result as a consecutive recoverable failure, across Model Turns", async () => {
    const { run } = openTestRun({
      model: {
        turns: [
          unknownCalls,
          toolCallTurn({ toolCallId: "call-3", name: "frobnicate", input: {} }),
          textTurn("Fixed it."),
        ],
      },
      limits: { maxConsecutiveRecoverableFailures: 10 },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(run.snapshot().counters.consecutiveRecoverableFailures).toBe(3);
  });

  it("prepares only the calls that pass Schema Validation and executes only those that pass preflight", async () => {
    const { run, portCalls } = openTestRun({
      tools: [fakeTool(), fakeWriteTool(), throwingTool({ phase: "prepare" })],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "frobnicate", input: {} },
            { toolCallId: "call-2", name: "echo", arguments: "{" },
            { toolCallId: "call-3", name: "write", input: { path: 7 } },
            { toolCallId: "call-4", name: "write", input: { path: "../outside.ts" } },
            { toolCallId: "call-5", name: "explode", input: {} },
            { toolCallId: "call-6", name: "echo", input: {} },
            { toolCallId: "call-7", name: "echo", input: {} },
          ),
          textTurn("Fixed it."),
        ],
      },
      limits: { maxConsecutiveRecoverableFailures: 10 },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(portCalls.filter((call) => call.startsWith("tool."))).toEqual([
      "tool.prepare(write)",
      "tool.prepare(explode)",
      "tool.prepare(echo)",
      "tool.execute(echo)",
      "tool.prepare(echo)",
      "tool.execute(echo)",
    ]);
  });

  it("enters awaiting_approval and emits approval_requested when a mutating call passes preflight under the ask policy", async () => {
    const { run } = openTestRun({
      tools: [fakeTool(), fakeWriteTool()],
      model: {
        turns: [
          toolCallTurn(
            { toolCallId: "call-1", name: "frobnicate", input: {} },
            { toolCallId: "call-2", name: "write", input: { path: "src/a.ts" } },
            { toolCallId: "call-3", name: "echo", input: {} },
          ),
          textTurn("Fixed it."),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");

    const snapshot = run.snapshot();
    expect(snapshot.phase).toBe("awaiting_approval");
    expect(snapshot).toMatchObject({
      phase: "awaiting_approval",
      toolCall: { id: "tool_call-2", name: "write" },
      queuedToolCalls: [{ id: "tool_call-3" }],
      approval: {
        approvalId: "approval-1",
        summary: "write src/a.ts",
        policy: "ask",
      },
    });

    // Allow the call so the run can settle
    await run.dispatch({
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    });
    const result = await run.result();
    expect(result.outcome).toBe("succeeded");
  });
});
