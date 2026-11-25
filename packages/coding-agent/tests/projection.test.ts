import { describe, expect, it } from "bun:test";
import {
  type AgentResult,
  type ExecutableTool,
  type ModelPort,
  openAgentRun,
  type RepoPath,
  type RunEvent,
  type ToolRegistry,
} from "@coding-agent/agent-core";
import type {
  AssistantMessage,
  ModelStream,
  ModelStreamEvent,
  ToolCallBlock,
} from "@coding-agent/ai";
import { BashParams } from "@coding-agent/tools";
import type { TuiModel } from "@coding-agent/tui";
import { projectRunEvent } from "../src/index.ts";

type EventType = RunEvent["type"];
type DataOf<Type extends EventType> = Extract<RunEvent, { type: Type }>["data"];

const EMPTY: TuiModel = { transcript: [] };
const usage = { inputTokens: 1, outputTokens: 1 };

// Builds Run Events of one Agent Run with consecutive sequence numbers.
function runEvents(runId = "s1") {
  let sequence = 0;
  return <Type extends EventType>(type: Type, data: DataOf<Type>): RunEvent =>
    ({
      runId,
      sequence: ++sequence,
      occurredAt: "2026-11-18T00:00:00.000Z",
      type,
      data,
    }) as RunEvent;
}

function project(events: readonly RunEvent[], initial: TuiModel = EMPTY): TuiModel {
  return events.reduce((model, event) => projectRunEvent(event, model), initial);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    model: "scripted",
    finishReason: { reason: "end_turn", rawReason: "stop" },
    usage,
  };
}

function settled(result: Partial<AgentResult> & Pick<AgentResult, "outcome">): AgentResult {
  return {
    usage,
    workspaceChanged: false,
    partialChangesPossible: false,
    lastSequence: 1,
    ...result,
  } as AgentResult;
}

const event = runEvents();
const started = event("run_started", { task: { objective: "Fix the failing test" } });
const messageStarted = event("assistant_message_started", { modelTurnId: "t1", messageId: "m1" });
const bashQueued = event("tool_call_queued", {
  modelTurnId: "t1",
  queueIndex: 0,
  toolCall: { id: "c1", name: "bash", arguments: JSON.stringify({ command: "bun test" }) },
});
const bashStarted = event("tool_execution_started", { toolCallId: "c1", mutation: "mutating" });

function progress(output: string, toolCallId = "c1"): RunEvent {
  return event("tool_execution_progress", { toolCallId, update: { output } });
}

describe("projectRunEvent", () => {
  it("is pure: it never mutates the previous model and returns a new one for a change", () => {
    const prev = deepFreeze(project([started, messageStarted, bashQueued, bashStarted]));
    const snapshot = structuredClone(prev);

    const next = project(
      [
        progress("1 pass\n"),
        event("tool_call_completed", {
          toolCallId: "c1",
          outcome: "succeeded",
          result: { toolCallId: "c1", toolName: "bash", content: "1 pass", isError: false },
        }),
        event("run_settled", { result: settled({ outcome: "cancelled", cancellation: {} }) }),
      ],
      prev,
    );

    expect(prev).toEqual(snapshot);
    expect(next).not.toBe(prev);
    expect(next.transcript).toHaveLength(prev.transcript.length + 1);
  });

  it("adds the Coding Task when an Agent Run starts and keeps the Agent Runs before it", () => {
    const second = runEvents("s2");
    const model = project([
      started,
      event("run_settled", { result: settled({ outcome: "succeeded" }) }),
      second("run_started", { task: { objective: "Now add a test" } }),
    ]);

    expect(model.transcript.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "user", id: "s1/task" },
      { kind: "outcome", id: "s1/outcome" },
      { kind: "user", id: "s2/task" },
    ]);
    expect(model.transcript[2]).toEqual({ kind: "user", id: "s2/task", text: "Now add a test" });
  });

  describe("Assistant Messages", () => {
    it("stream text and displayable reasoning as they arrive", () => {
      const model = project([
        started,
        messageStarted,
        event("assistant_content_delta", {
          messageId: "m1",
          blockIndex: 0,
          kind: "reasoning",
          delta: "The test ",
        }),
        event("assistant_content_delta", {
          messageId: "m1",
          blockIndex: 0,
          kind: "reasoning",
          delta: "expects a sum.",
        }),
        event("assistant_content_delta", {
          messageId: "m1",
          blockIndex: 1,
          kind: "text",
          delta: "I'll fix ",
        }),
        event("assistant_content_delta", {
          messageId: "m1",
          blockIndex: 1,
          kind: "text",
          delta: "add.",
        }),
      ]);

      expect(model.transcript.at(-1)).toEqual({
        kind: "assistant",
        id: "s1/message/m1",
        text: "I'll fix add.",
        reasoning: "The test expects a sum.",
        status: "streaming",
      });
    });

    it("take the completed message's text", () => {
      const model = project([
        started,
        messageStarted,
        event("assistant_content_delta", {
          messageId: "m1",
          blockIndex: 0,
          kind: "text",
          delta: "Do",
        }),
        event("assistant_message_completed", {
          messageId: "m1",
          outcome: "completed",
          message: message("Done."),
        }),
      ]);

      expect(model.transcript.at(-1)).toEqual({
        kind: "assistant",
        id: "s1/message/m1",
        text: "Done.",
        status: "completed",
      });
    });

    it.each(["failed", "cancelled"] as const)("show an interrupted message as %s", (outcome) => {
      const model = project([
        started,
        messageStarted,
        event("assistant_content_delta", {
          messageId: "m1",
          blockIndex: 0,
          kind: "text",
          delta: "Partial",
        }),
        event("assistant_message_completed", { messageId: "m1", outcome, message: message("") }),
      ]);

      expect(model.transcript.at(-1)).toEqual({
        kind: "assistant",
        id: "s1/message/m1",
        text: "Partial",
        status: outcome,
      });
    });
  });

  describe("Tool Calls", () => {
    it("appear queued, then running, then completed with their result", () => {
      const queued = project([started, bashQueued]);
      const running = projectRunEvent(bashStarted, queued);
      const completed = projectRunEvent(
        event("tool_call_completed", {
          toolCallId: "c1",
          outcome: "failed",
          result: {
            toolCallId: "c1",
            toolName: "bash",
            content: "1 fail",
            isError: true,
            error: { code: "NON_ZERO_EXIT", message: "exit 1" },
            metadata: { durationMs: 5, truncated: true },
          },
        }),
        running,
      );

      expect(queued.transcript.at(-1)).toEqual({
        kind: "tool_call",
        id: "s1/tool_call/c1",
        toolName: "bash",
        summary: "bun test",
        status: "queued",
      });
      expect(running.transcript.at(-1)).toMatchObject({ status: "executing" });
      expect(completed.transcript.at(-1)).toEqual({
        kind: "tool_call",
        id: "s1/tool_call/c1",
        toolName: "bash",
        summary: "bun test",
        status: "failed",
        result: { content: "1 fail", isError: true, errorCode: "NON_ZERO_EXIT", truncated: true },
      });
    });

    it("show a Skipped Tool Call with its reason and without a Tool Result", () => {
      const model = project([
        started,
        bashQueued,
        event("tool_call_completed", { toolCallId: "c1", outcome: "skipped", reason: "CANCELLED" }),
      ]);

      expect(model.transcript.at(-1)).toEqual({
        kind: "tool_call",
        id: "s1/tool_call/c1",
        toolName: "bash",
        summary: "bun test",
        status: "skipped",
        skipReason: "CANCELLED",
      });
    });

    it.each([
      ["read", { path: "src/math.ts", offset: 10 }, "src/math.ts"],
      ["bash", { command: "bun   test\n  --watch" }, "bun test --watch"],
      ["grep", { pattern: "add", limit: 3 }, "pattern=add limit=3"],
    ])("summarize %s arguments on one line", (name, args, summary) => {
      const model = project([
        started,
        event("tool_call_queued", {
          modelTurnId: "t1",
          queueIndex: 0,
          toolCall: { id: "c2", name, arguments: JSON.stringify(args) },
        }),
      ]);

      expect(model.transcript.at(-1)).toMatchObject({ summary });
    });

    it("show malformed arguments as they came, cut to one short line", () => {
      const long = `{"path": "${"a".repeat(200)}`;
      const model = project([
        started,
        event("tool_call_queued", {
          modelTurnId: "t1",
          queueIndex: 0,
          toolCall: { id: "c2", name: "read", arguments: long },
        }),
      ]);
      const entry = model.transcript.at(-1);
      const summary = entry?.kind === "tool_call" ? entry.summary : "";

      expect(Array.from(summary)).toHaveLength(120);
      expect(summary.startsWith('{"path": "aaa')).toBe(true);
      expect(summary.endsWith("…")).toBe(true);
    });
  });

  describe("Tool Progress", () => {
    const running = project([started, bashQueued, bashStarted]);

    it("shows the latest output of an executing Tool Call, each update replacing the last", () => {
      const first = projectRunEvent(progress("line 1\n"), running);
      const second = projectRunEvent(progress("line 1\nline 2\n"), first);

      expect(first.transcript.at(-1)).toMatchObject({ status: "executing", progress: "line 1\n" });
      expect(second.transcript.at(-1)).toMatchObject({ progress: "line 1\nline 2\n" });
    });

    it("is cleared when the Tool Call completes", () => {
      const model = project(
        [
          progress("line 1\n"),
          event("tool_call_completed", {
            toolCallId: "c1",
            outcome: "succeeded",
            result: { toolCallId: "c1", toolName: "bash", content: "done", isError: false },
          }),
        ],
        running,
      );

      expect(model.transcript.at(-1)).not.toHaveProperty("progress");
      expect(model.transcript.at(-1)).toMatchObject({ status: "succeeded" });
    });

    it("leaves the model unchanged for a call that is not executing", () => {
      const queued = project([started, bashQueued]);
      const completed = project(
        [event("tool_call_completed", { toolCallId: "c1", outcome: "cancelled" })],
        running,
      );
      const withOutput = projectRunEvent(progress("same\n"), running);

      expect(projectRunEvent(progress("early\n"), queued)).toBe(queued);
      expect(projectRunEvent(progress("late\n"), completed)).toBe(completed);
      expect(projectRunEvent(progress("other\n", "unknown"), running)).toBe(running);
      expect(projectRunEvent(progress("same\n"), withOutput)).toBe(withOutput);
    });
  });

  describe("Approvals", () => {
    const writeQueued = event("tool_call_queued", {
      modelTurnId: "t1",
      queueIndex: 0,
      toolCall: {
        id: "c3",
        name: "write",
        arguments: JSON.stringify({ path: "a.ts", content: "x" }),
      },
    });
    const requested = event("approval_requested", {
      approvalId: "ap1",
      toolCallId: "c3",
      summary: "Write 1 line to a.ts",
      policy: "ask",
    });
    const pending = project([started, writeQueued, requested]);

    it("open with the tool and its mutation summary while the call awaits approval", () => {
      expect(pending.pendingApproval).toEqual({
        approvalId: "ap1",
        toolName: "write",
        summary: "Write 1 line to a.ts",
      });
      expect(pending.transcript.at(-1)).toMatchObject({ status: "awaiting_approval" });
    });

    it("close when allowed, and the call waits to execute", () => {
      const model = projectRunEvent(
        event("approval_resolved", {
          approvalId: "ap1",
          toolCallId: "c3",
          status: "allowed",
          decidedBy: "user",
        }),
        pending,
      );

      expect(model).not.toHaveProperty("pendingApproval");
      expect(model.transcript.at(-1)).toMatchObject({ status: "queued" });
    });

    it("close when denied, and the call completes as denied with the reason", () => {
      const model = project(
        [
          event("approval_resolved", {
            approvalId: "ap1",
            toolCallId: "c3",
            status: "denied",
            decidedBy: "user",
            reason: "wrong file",
          }),
          event("tool_call_completed", {
            toolCallId: "c3",
            outcome: "denied",
            result: {
              toolCallId: "c3",
              toolName: "write",
              content: "Denied: wrong file",
              isError: true,
              error: { code: "APPROVAL_DENIED", message: "Denied: wrong file" },
            },
          }),
        ],
        pending,
      );

      expect(model).not.toHaveProperty("pendingApproval");
      expect(model.transcript.at(-1)).toMatchObject({
        status: "denied",
        result: { content: "Denied: wrong file", isError: true, errorCode: "APPROVAL_DENIED" },
      });
    });

    it("never open under auto-approve", () => {
      const queued = project([started, writeQueued]);
      const autoRequested = event("approval_requested", {
        approvalId: "ap2",
        toolCallId: "c3",
        summary: "Write 1 line to a.ts",
        policy: "auto-approve",
      });

      expect(projectRunEvent(autoRequested, queued)).toBe(queued);
    });

    it("close when the Agent Run settles while one is pending", () => {
      const model = projectRunEvent(
        event("run_settled", { result: settled({ outcome: "cancelled", cancellation: {} }) }),
        pending,
      );

      expect(model).not.toHaveProperty("pendingApproval");
    });
  });

  describe("Verification", () => {
    const verifying = project([
      started,
      event("verification_started", {
        verificationId: "v1",
        candidate: { modelTurnId: "t1", messageId: "m1" },
      }),
    ]);

    it("shows its start and its outcome with the evidence", () => {
      const model = projectRunEvent(
        event("verification_completed", {
          verificationId: "v1",
          outcome: "continue",
          evidence: [
            {
              type: "command_execution",
              command: "bun test",
              exitCode: 1,
              stdout: "",
              stderr: "",
              durationMs: 5,
            },
            {
              type: "command_system_failure",
              command: "make check",
              failureKind: "timed_out",
              message: "timed out",
              durationMs: 5,
            },
            { type: "no_command_configured", workspaceChanged: true },
          ],
        }),
        verifying,
      );

      expect(verifying.transcript.at(-1)).toEqual({
        kind: "verification",
        id: "s1/verification/v1",
        status: "running",
      });
      expect(model.transcript.at(-1)).toEqual({
        kind: "verification",
        id: "s1/verification/v1",
        status: "continue",
        evidence: [
          "bun test exited 1",
          "make check timed out",
          "no verification command configured",
        ],
      });
    });

    it("handles verification_progress, which the MVP never emits, without a change", () => {
      expect(
        projectRunEvent(
          event("verification_progress", { verificationId: "v1", update: { message: "1/3" } }),
          verifying,
        ),
      ).toBe(verifying);
    });
  });

  describe("the end of an Agent Run", () => {
    it("shows the limit that ended it and the failure it settled with", () => {
      const limited = runEvents();
      const model = project([
        limited("run_started", { task: { objective: "Fix the failing test" } }),
        limited("runtime_limit_reached", { kind: "maxToolCalls", limit: 100, observed: 101 }),
        limited("run_settled", {
          result: settled({
            outcome: "failed",
            failure: { code: "LIMIT_EXCEEDED", message: "Tool Call limit exceeded" },
            workspaceChanged: true,
            partialChangesPossible: true,
          }),
        }),
      ]);

      expect(model.transcript.slice(1)).toEqual([
        {
          kind: "notice",
          id: "s1/notice/2",
          text: "limit reached: maxToolCalls (observed 101, limit 100)",
        },
        {
          kind: "outcome",
          id: "s1/outcome",
          status: "failed",
          failure: { code: "LIMIT_EXCEEDED", message: "Tool Call limit exceeded" },
          workspaceChanged: true,
          partialChangesPossible: true,
        },
      ]);
    });

    it("shows a requested cancellation and whether the workspace changed", () => {
      const cancel = runEvents("s3");
      const model = project([
        cancel("run_started", { task: { objective: "Refactor" } }),
        cancel("cancellation_requested", { reason: "user", requestedFrom: "streaming_model" }),
        cancel("run_settled", {
          result: settled({
            outcome: "cancelled",
            cancellation: { reason: "user" },
            workspaceChanged: true,
          }),
        }),
      ]);

      expect(model.transcript.slice(1)).toEqual([
        { kind: "notice", id: "s3/notice/2", text: "cancellation requested: user" },
        {
          kind: "outcome",
          id: "s3/outcome",
          status: "cancelled",
          workspaceChanged: true,
          partialChangesPossible: false,
        },
      ]);
    });

    it("leaves Model Turn bookkeeping out of the model", () => {
      const model = project([started]);

      for (const unchanged of [
        event("model_turn_started", {
          modelTurnId: "t1",
          index: 0,
          model: { id: "m", name: "M", provider: "p" } as never,
        }),
        event("candidate_completion_detected", { modelTurnId: "t1", messageId: "m1" }),
        event("model_turn_completed", { modelTurnId: "t1", outcome: "completed", usage }),
      ]) {
        expect(projectRunEvent(unchanged, model)).toBe(model);
      }
    });
  });
});

// A recorded Agent Run: a real Agent Run driven by a scripted model and a fake bash tool, under
// the ask Approval Policy, whose whole event sequence is projected.
describe("a recorded event sequence", () => {
  function streamOf(events: readonly ModelStreamEvent[], result: AssistantMessage): ModelStream {
    return {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      result: async () => result,
    };
  }

  function scriptedModel(): ModelPort {
    const call: ToolCallBlock = {
      type: "tool_call",
      toolCallId: "provider-call",
      name: "bash",
      arguments: JSON.stringify({ command: "bun test" }),
    };
    const first: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Running the tests." }, call],
      model: "scripted",
      finishReason: { reason: "tool_call", rawReason: "tool_use" },
      usage,
    };
    const last = message("All tests pass.");
    const turns = [
      streamOf(
        [
          { type: "stream_start" },
          { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Running the tests." },
          },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, block: call },
          { type: "content_block_stop", index: 1 },
          { type: "turn_end", message: first },
        ],
        first,
      ),
      streamOf(
        [
          { type: "stream_start" },
          { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "All tests pass." },
          },
          { type: "content_block_stop", index: 0 },
          { type: "turn_end", message: last },
        ],
        last,
      ),
    ];
    return {
      identity: { id: "scripted", name: "Scripted", provider: "scripted" },
      capabilities: {
        parallelToolCallControl: true,
        cancellation: "client_abort_only",
        toolArgumentDelivery: "whole",
        usageTiming: "final",
        serverSideTools: false,
      },
      stream: () => {
        const next = turns.shift();
        if (!next) throw new Error("the scripted model has no more turns");
        return next;
      },
    };
  }

  // Reports one progress update, then succeeds, without starting a process.
  const fakeBash: ExecutableTool<typeof BashParams> = {
    name: "bash",
    description: "Runs a command.",
    parameters: BashParams,
    mutation: "mutating",
    prepare: async (input) => ({
      ok: true,
      prepared: { input, paths: [], summary: `Run ${input.command}` },
    }),
    execute: async (_prepared, ctx) => {
      ctx.onProgress({ output: "1 pass\n" });
      return { isError: false, content: "1 pass" };
    },
  };

  it("projects into the expected model", async () => {
    const tools: ToolRegistry = {
      get: (name) => (name === "bash" ? (fakeBash as ExecutableTool) : undefined),
      list: () => [fakeBash as ExecutableTool],
    };
    const repoRoot = "/repo" as RepoPath;
    let id = 0;
    const opened = openAgentRun({
      model: scriptedModel(),
      systemPrompt: "Test.",
      tools,
      workspace: {
        repoRoot,
        resolveExisting: async () => ({ ok: true, path: repoRoot }),
        resolveForCreate: async () => ({ ok: true, path: repoRoot }),
      },
      approvalPolicy: "ask",
      verification: {
        verify: async () => ({
          outcome: "succeeded",
          evidence: [
            {
              type: "command_execution",
              command: "bun test",
              exitCode: 0,
              stdout: "1 pass",
              stderr: "",
              durationMs: 1,
            },
          ],
        }),
      },
      limits: {
        maxModelTurns: 5,
        maxToolCalls: 5,
        maxDurationMs: 60_000,
        maxConsecutiveRecoverableFailures: 3,
        cancellationGraceMs: 5_000,
      },
      clock: {
        now: () => "2026-11-18T00:00:00.000Z",
        monotonicMs: () => 0,
        setTimer: (delayMs, callback) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      ids: { next: (kind) => `${kind}-${++id}` },
    });
    if (!opened.ok) throw new Error(opened.message);
    const { run } = opened;

    const models: TuiModel[] = [];
    let model = EMPTY;
    const observed = (async () => {
      for await (const next of run.events()) {
        model = projectRunEvent(next, model);
        models.push(model);
        if (next.type === "approval_requested") {
          void run.dispatch({
            type: "resolve_approval",
            approvalId: next.data.approvalId,
            decision: "allow",
          });
        }
      }
    })();
    await run.dispatch({ type: "start", task: { objective: "Make the tests pass" } });
    const result = await run.result();
    await observed;

    expect(result.outcome).toBe("succeeded");
    // The overlay was open while the call awaited its Approval.
    expect(models.some((each) => each.pendingApproval?.summary === "Run bun test")).toBe(true);
    // The latest output showed under the call while it executed.
    expect(
      models.some((each) =>
        each.transcript.some(
          (entry) => entry.kind === "tool_call" && entry.progress === "1 pass\n",
        ),
      ),
    ).toBe(true);
    expect(model).toEqual({
      transcript: [
        { kind: "user", id: "run-1/task", text: "Make the tests pass" },
        {
          kind: "assistant",
          id: "run-1/message/assistant_message-3",
          text: "Running the tests.",
          status: "completed",
        },
        {
          kind: "tool_call",
          id: "run-1/tool_call/tool_call-4",
          toolName: "bash",
          summary: "bun test",
          status: "succeeded",
          result: { content: "1 pass", isError: false },
        },
        {
          kind: "assistant",
          id: "run-1/message/assistant_message-7",
          text: "All tests pass.",
          status: "completed",
        },
        {
          kind: "verification",
          id: "run-1/verification/verification-8",
          status: "succeeded",
          evidence: ["bun test exited 0"],
        },
        {
          kind: "outcome",
          id: "run-1/outcome",
          status: "succeeded",
          workspaceChanged: true,
          partialChangesPossible: false,
        },
      ],
    });
  });
});
