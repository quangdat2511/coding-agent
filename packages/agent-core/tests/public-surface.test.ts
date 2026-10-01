import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@coding-agent/ai";
import { Type } from "typebox";
import type {
  AgentFailureCode,
  AgentResult,
  AgentSession,
  AgentState,
  ApprovalPolicy,
  Clock,
  CommandResult,
  ExecutableTool,
  IdKind,
  IdSource,
  JsonValue,
  ModelPort,
  NormalizedToolCall,
  OpenSessionConfig,
  OpenSessionResult,
  PathResolution,
  RepoPath,
  SessionCommand,
  SessionEvent,
  SessionLimits,
  ToolErrorCode,
  ToolOutcome,
  ToolRegistry,
  UsageTotals,
  VerificationDecision,
  VerificationPolicy,
  WorkspaceResolver,
} from "@/index";
import * as surface from "@/index";

const asRepoPath = (path: string): RepoPath => path as RepoPath;

describe("workspace port", () => {
  const workspace: WorkspaceResolver = {
    repoRoot: asRepoPath("/repo"),
    async resolveExisting(input) {
      return { ok: true, path: asRepoPath(`/repo/${input}`) };
    },
    async resolveForCreate(input) {
      return { ok: true, path: asRepoPath(`/repo/${input}`) };
    },
  };

  it("accepts a resolved path where a validated path is required", async () => {
    const readFrom = (path: RepoPath): string => path;
    const resolution = await workspace.resolveExisting("src/a.ts");

    if (!resolution.ok) throw new Error("expected the fake resolver to succeed");

    expect(readFrom(resolution.path)).toBe("/repo/src/a.ts");
  });

  it("rejects an unvalidated string where a validated path is required (compile-time)", () => {
    const readFrom = (path: RepoPath): string => path;
    const unvalidated = "src/a.ts";

    // @ts-expect-error a plain string is not a RepoPath
    expect(readFrom(unvalidated)).toBe("src/a.ts");
  });

  it("limits path resolution failures to the three path error codes (compile-time)", () => {
    const outside: PathResolution = {
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: "escapes the repository root",
    };
    // @ts-expect-error TIMEOUT is not a path resolution failure
    const wrong: PathResolution = { ok: false, code: "TIMEOUT", message: "not a path error" };

    expect(outside.ok).toBe(false);
    expect(wrong.ok).toBe(false);
  });
});

describe("tool ports", () => {
  const EchoParams = Type.Object({ text: Type.String() });

  const echo: ExecutableTool<typeof EchoParams> = {
    name: "echo",
    description: "Echo the text back",
    parameters: EchoParams,
    mutation: "read_only",
    async prepare(input) {
      return { ok: true, prepared: { input, paths: [], summary: `echo ${input.text}` } };
    },
    async execute(prepared) {
      return { isError: false, content: prepared.input.text };
    },
  };

  it("lets a tool with a concrete schema live in the registry", async () => {
    const registry: ToolRegistry = {
      get: (name) => (name === echo.name ? echo : undefined),
      list: () => [echo],
    };
    const tool = registry.get("echo");
    if (!tool) throw new Error("expected echo to be registered");

    const prepared = await tool.prepare(
      { text: "hi" },
      {
        workspace: {
          repoRoot: asRepoPath("/repo"),
          resolveExisting: async () => ({ ok: false, code: "NOT_FOUND", message: "none" }),
          resolveForCreate: async () => ({ ok: false, code: "NOT_FOUND", message: "none" }),
        },
        signal: new AbortController().signal,
      },
    );

    expect(prepared.ok).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it("declares the thirteen tool error codes", () => {
    const codes = {
      SCHEMA_VIOLATION: true,
      NOT_FOUND: true,
      IS_DIRECTORY: true,
      PATH_OUTSIDE_REPO: true,
      PERMISSION_DENIED: true,
      NO_MATCH: true,
      AMBIGUOUS_MATCH: true,
      PARENT_CREATION_FAILED: true,
      TIMEOUT: true,
      SIGNAL: true,
      NON_ZERO_EXIT: true,
      APPROVAL_DENIED: true,
      TOOL_INTERNAL_ERROR: true,
    } satisfies Record<ToolErrorCode, true>;

    expect(Object.keys(codes)).toHaveLength(13);
  });

  it("identifies a failed tool outcome by a discriminant, not instanceof (compile-time)", () => {
    const outcome = {
      isError: true,
      content: "no such file",
      error: { code: "NOT_FOUND", message: "no such file" },
    } as ToolOutcome;

    if (outcome.isError) {
      const code: ToolErrorCode = outcome.error.code;
      expect(code).toBe("NOT_FOUND");
    }
  });
});

describe("injected ports", () => {
  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "fake",
    finishReason: { reason: "end_turn", rawReason: "stop" },
  };

  const model: ModelPort = {
    identity: { id: "fake", name: "Fake", provider: "fake" },
    capabilities: {
      parallelToolCallControl: false,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "whole",
      usageTiming: "final",
      serverSideTools: false,
    },
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "turn_end", message: finalMessage };
        },
        result: async () => finalMessage,
      };
    },
  };

  it("streams a model response that resolves to an assistant message", async () => {
    const stream = model.stream(
      { messages: [] },
      { signal: new AbortController().signal, parallelToolCalls: false },
    );

    expect(await stream.result()).toEqual(finalMessage);
  });

  it("always asks the model to disable parallel tool calls (compile-time)", () => {
    const request = { signal: new AbortController().signal, parallelToolCalls: true } as const;

    // @ts-expect-error Agent Core only ever sends parallelToolCalls: false
    model.stream({ messages: [] }, request);
  });

  it("separates wall-clock time from monotonic time", () => {
    const clock: Clock = { now: () => "2026-10-01T00:00:00.000Z", monotonicMs: () => 42 };

    expect(clock.now()).toBe("2026-10-01T00:00:00.000Z");
    expect(clock.monotonicMs()).toBe(42);
  });

  it("issues ids for exactly six kinds of thing", () => {
    const kinds = {
      session: true,
      model_turn: true,
      assistant_message: true,
      tool_call: true,
      approval: true,
      verification: true,
    } satisfies Record<IdKind, true>;
    const ids: IdSource = { next: (kind) => `${kind}-1` };

    // @ts-expect-error content blocks are indexed, not given ids
    ids.next("content_block");

    expect(Object.keys(kinds)).toHaveLength(6);
    expect(ids.next("tool_call")).toBe("tool_call-1");
  });

  it("bounds a session by turns, tool calls, duration, failures and cancellation grace", () => {
    const limits: SessionLimits = {
      maxModelTurns: 20,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxConsecutiveRecoverableFailures: 3,
      cancellationGraceMs: 2_000,
    };
    const withVerificationAttempts: SessionLimits = {
      ...limits,
      // @ts-expect-error ADR 0002 excludes a separate verification-attempt limit
      maxVerificationAttempts: 3,
    };

    expect(Object.keys(limits)).toHaveLength(5);
    expect(withVerificationAttempts.maxModelTurns).toBe(20);
  });

  it("offers exactly two approval policies (compile-time)", () => {
    const policies = { ask: true, "auto-approve": true } satisfies Record<ApprovalPolicy, true>;
    const select = (policy: ApprovalPolicy): ApprovalPolicy => policy;

    // @ts-expect-error there is no bypass policy
    select("bypass");

    expect(Object.keys(policies)).toHaveLength(2);
  });
});

describe("verification port", () => {
  const candidate = {
    transcript: [],
    finalMessage: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      model: "fake",
      finishReason: { reason: "end_turn", rawReason: "stop" },
    } satisfies AssistantMessage,
    workspaceChanged: true,
  };
  const context = { signal: new AbortController().signal, onProgress: () => {} };

  it("carries the three decisions with their evidence", async () => {
    const decisions: VerificationDecision[] = [
      {
        outcome: "succeeded",
        evidence: [{ type: "no_command_configured", workspaceChanged: true }],
      },
      {
        outcome: "continue",
        evidence: [
          {
            type: "command_execution",
            command: "bun test",
            exitCode: 1,
            stdout: "",
            stderr: "1 fail",
            durationMs: 120,
          },
        ],
        feedback: { message: "[Verification Failed]" },
      },
      {
        outcome: "failed",
        evidence: [
          {
            type: "command_system_failure",
            command: "bun tset",
            failureKind: "launch_failed",
            message: "command not found",
            exitCode: 127,
            durationMs: 3,
          },
        ],
        message: "verification command could not run",
      },
    ];
    const policy: VerificationPolicy = {
      async verify(_candidate, ctx) {
        ctx.onProgress({ message: "running" });
        return decisions[1] as VerificationDecision;
      },
    };

    expect((await policy.verify(candidate, context)).outcome).toBe("continue");
    expect(decisions.map((decision) => decision.outcome)).toEqual([
      "succeeded",
      "continue",
      "failed",
    ]);
  });

  it("requires feedback to continue and a message to fail (compile-time)", () => {
    // @ts-expect-error continue needs feedback for the next Model Turn
    const noFeedback: VerificationDecision = { outcome: "continue", evidence: [] };
    // @ts-expect-error failed needs a message
    const noMessage: VerificationDecision = { outcome: "failed", evidence: [] };

    expect([noFeedback.outcome, noMessage.outcome]).toEqual(["continue", "failed"]);
  });

  it("keeps the evidence union closed (compile-time)", () => {
    const decision: VerificationDecision = {
      outcome: "succeeded",
      // @ts-expect-error only the three ADR 0003 evidence records exist
      evidence: [{ type: "screenshot" }],
    };

    expect(decision.outcome).toBe("succeeded");
  });
});

describe("agent session interface", () => {
  it("has four operations", () => {
    const operations = {
      dispatch: true,
      snapshot: true,
      events: true,
      result: true,
    } satisfies Record<keyof AgentSession, true>;

    expect(Object.keys(operations)).toHaveLength(4);
  });

  it("accepts three commands", () => {
    const commands = {
      start: true,
      resolve_approval: true,
      cancel: true,
    } satisfies Record<SessionCommand["type"], true>;
    const resolve: SessionCommand = {
      type: "resolve_approval",
      approvalId: "approval-1",
      decision: "allow",
    };
    // @ts-expect-error a decision is allow or deny
    const approve: SessionCommand = { ...resolve, decision: "approve" };

    expect(Object.keys(commands)).toHaveLength(3);
    expect(approve.type).toBe("resolve_approval");
  });

  it("refuses a command with one of four codes", () => {
    const accepted: CommandResult = { accepted: true, sequence: 4 };
    const refusals = {
      INVALID_STATE: true,
      ALREADY_STARTED: true,
      STALE_APPROVAL: true,
      ALREADY_SETTLED: true,
    } satisfies Record<Extract<CommandResult, { accepted: false }>["code"], true>;

    expect(accepted.accepted).toBe(true);
    expect(Object.keys(refusals)).toHaveLength(4);
  });
});

describe("agent result", () => {
  const usage: UsageTotals = { inputTokens: 10, outputTokens: 5 };
  const base = { usage, workspaceChanged: false, partialChangesPossible: false, lastSequence: 7 };
  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "fake",
    finishReason: { reason: "end_turn", rawReason: "stop" },
  };

  const describeResult = (result: AgentResult): string => {
    switch (result.outcome) {
      case "succeeded":
        return `succeeded after ${result.verification.outcome}`;
      case "failed":
        return result.failure.code;
      case "cancelled":
        return result.cancellation.reason ?? "no reason";
    }
  };

  it("narrows on its outcome discriminant", () => {
    expect(
      describeResult({
        ...base,
        outcome: "succeeded",
        finalMessage,
        verification: { outcome: "succeeded", evidence: [] },
      }),
    ).toBe("succeeded after succeeded");
    expect(
      describeResult({
        ...base,
        outcome: "failed",
        failure: { code: "LIMIT_EXCEEDED", message: "too many turns" },
      }),
    ).toBe("LIMIT_EXCEEDED");
    expect(
      describeResult({ ...base, outcome: "cancelled", cancellation: { reason: "user" } }),
    ).toBe("user");
  });

  it("requires a final message and verification summary to succeed (compile-time)", () => {
    // @ts-expect-error a succeeded result carries its final message and verification
    const incomplete: AgentResult = { ...base, outcome: "succeeded" };

    expect(incomplete.outcome).toBe("succeeded");
  });

  it("has six failure codes", () => {
    const codes = {
      MODEL_FAILURE: true,
      MODEL_PROTOCOL_ERROR: true,
      LIMIT_EXCEEDED: true,
      VERIFICATION_FAILED: true,
      CANCELLATION_TIMEOUT: true,
      INTERNAL_ERROR: true,
    } satisfies Record<AgentFailureCode, true>;

    expect(Object.keys(codes)).toHaveLength(6);
  });

  it("keeps raw Error values out of failure details (compile-time)", () => {
    const details: Readonly<Record<string, JsonValue>> = { phase: "streaming_model", attempt: 1 };
    const failed: AgentResult = {
      ...base,
      outcome: "failed",
      failure: {
        code: "MODEL_FAILURE",
        message: "stream failed",
        details,
      },
    };
    // @ts-expect-error an Error instance is not a JSON value
    const leaked: JsonValue = new Error("boom");

    expect(failed.outcome).toBe("failed");
    expect(leaked).toBeInstanceOf(Error);
  });
});

describe("session construction", () => {
  it("takes nine injected collaborators", () => {
    const fields = {
      model: true,
      systemPrompt: true,
      tools: true,
      workspace: true,
      approvalPolicy: true,
      verification: true,
      limits: true,
      clock: true,
      ids: true,
    } satisfies Record<keyof OpenSessionConfig, true>;

    expect(Object.keys(fields)).toHaveLength(9);
  });

  it("refuses with a configuration error that names the field", () => {
    const refused: OpenSessionResult = {
      ok: false,
      code: "INVALID_CONFIGURATION",
      message: "clock is required",
      field: "clock",
    };

    if (refused.ok) throw new Error("expected a refusal");

    expect(refused.code).toBe("INVALID_CONFIGURATION");
    expect(refused.field).toBe("clock");
  });
});

describe("agent state", () => {
  const common = {
    sessionId: "session-1",
    task: { objective: "fix the failing test" },
    transcript: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    counters: { modelTurns: 1, toolCalls: 0, consecutiveRecoverableFailures: 0 },
    activeDurationMs: 0,
    workspaceChanged: false,
    partialChangesPossible: false,
    lastSequence: 3,
  };
  const modelTurn = { modelTurnId: "turn-1", index: 0 };
  const toolCall: NormalizedToolCall = {
    id: "tool-1",
    name: "write",
    arguments: '{"path":"a.ts","content":""}',
  };
  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "fake",
    finishReason: { reason: "end_turn", rawReason: "stop" },
  };
  const resultBase = {
    usage: common.usage,
    workspaceChanged: false,
    partialChangesPossible: false,
    lastSequence: 9,
  };

  const states: AgentState[] = [
    { ...common, phase: "ready" },
    {
      ...common,
      phase: "streaming_model",
      modelTurn,
      assistantMessage: { messageId: "message-1", blocks: [{ kind: "text", text: "Looking" }] },
    },
    {
      ...common,
      phase: "awaiting_approval",
      modelTurn,
      toolCall,
      queuedToolCalls: [],
      approval: { approvalId: "approval-1", summary: "write a.ts", policy: "ask" },
    },
    { ...common, phase: "executing_tool", modelTurn, toolCall, queuedToolCalls: [] },
    {
      ...common,
      phase: "verifying",
      verification: {
        verificationId: "verification-1",
        candidate: { modelTurnId: "turn-1", messageId: "message-1" },
      },
    },
    { ...common, phase: "cancelling", requestedFrom: "executing_tool", reason: "user" },
    {
      ...common,
      phase: "succeeded",
      result: {
        ...resultBase,
        outcome: "succeeded",
        finalMessage,
        verification: { outcome: "succeeded", evidence: [] },
      },
    },
    {
      ...common,
      phase: "failed",
      result: {
        ...resultBase,
        outcome: "failed",
        failure: { code: "LIMIT_EXCEEDED", message: "too many turns" },
      },
    },
    {
      ...common,
      phase: "cancelled",
      result: { ...resultBase, outcome: "cancelled", cancellation: { reason: "user" } },
    },
  ];

  const summarize = (state: AgentState): string => {
    switch (state.phase) {
      case "ready":
        return "ready";
      case "streaming_model":
        return `streaming ${state.assistantMessage.messageId}`;
      case "awaiting_approval":
        return `awaiting ${state.approval.approvalId} for ${state.toolCall.id}`;
      case "executing_tool":
        return `executing ${state.toolCall.id}`;
      case "verifying":
        return `verifying ${state.verification.verificationId}`;
      case "cancelling":
        return `cancelling from ${state.requestedFrom}`;
      case "succeeded":
      case "failed":
      case "cancelled":
        return state.result.outcome;
    }
  };

  it("has nine states, each carrying only its own phase data", () => {
    const phases = {
      ready: true,
      streaming_model: true,
      awaiting_approval: true,
      executing_tool: true,
      verifying: true,
      cancelling: true,
      succeeded: true,
      failed: true,
      cancelled: true,
    } satisfies Record<AgentState["phase"], true>;

    expect(Object.keys(phases)).toHaveLength(9);
    expect(states.map(summarize)).toEqual([
      "ready",
      "streaming message-1",
      "awaiting approval-1 for tool-1",
      "executing tool-1",
      "verifying verification-1",
      "cancelling from executing_tool",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });

  it("cannot represent a pending approval while streaming the model (compile-time)", () => {
    const impossible: AgentState = {
      ...common,
      phase: "streaming_model",
      modelTurn,
      assistantMessage: { messageId: "message-1", blocks: [] },
      // @ts-expect-error streaming_model has no approval
      approval: { approvalId: "approval-1", summary: "write a.ts", policy: "ask" },
    };

    expect(impossible.phase).toBe("streaming_model");
  });

  it("cannot settle into a terminal state with another outcome's result (compile-time)", () => {
    const mismatched: AgentState = {
      ...common,
      phase: "succeeded",
      // @ts-expect-error a succeeded state carries a succeeded result
      result: { ...resultBase, outcome: "cancelled", cancellation: {} },
    };

    expect(mismatched.phase).toBe("succeeded");
  });

  it("is a readonly snapshot (compile-time)", () => {
    const snapshot = states[0] as AgentState;

    // @ts-expect-error snapshots are readonly
    snapshot.lastSequence = 4;

    expect(snapshot.phase).toBe("ready");
  });
});

describe("session events", () => {
  type DataOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>["data"];
  type EventData = { [T in SessionEvent["type"]]: DataOf<T> };

  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "fake",
    finishReason: { reason: "end_turn", rawReason: "stop" },
  };
  const usage = { inputTokens: 10, outputTokens: 5 };
  const toolCall: NormalizedToolCall = { id: "tool-1", name: "write", arguments: "{}" };

  const payloads = {
    session_started: { task: { objective: "fix the failing test" } },
    cancellation_requested: { reason: "user", requestedFrom: "executing_tool" },
    runtime_limit_reached: { kind: "maxModelTurns", limit: 20, observed: 20 },
    session_settled: {
      result: {
        usage,
        workspaceChanged: true,
        partialChangesPossible: true,
        lastSequence: 19,
        outcome: "cancelled",
        cancellation: { reason: "user" },
      },
    },
    model_turn_started: {
      modelTurnId: "turn-1",
      index: 0,
      model: { id: "fake", name: "Fake", provider: "fake" },
    },
    assistant_message_started: { modelTurnId: "turn-1", messageId: "message-1" },
    assistant_content_delta: { messageId: "message-1", blockIndex: 0, kind: "text", delta: "Look" },
    assistant_message_completed: {
      messageId: "message-1",
      outcome: "completed",
      message: finalMessage,
    },
    model_turn_completed: { modelTurnId: "turn-1", outcome: "completed", usage },
    candidate_completion_detected: { modelTurnId: "turn-1", messageId: "message-1" },
    tool_call_queued: { modelTurnId: "turn-1", queueIndex: 0, toolCall },
    approval_requested: {
      approvalId: "approval-1",
      toolCallId: "tool-1",
      summary: "write a.ts",
      policy: "ask",
    },
    approval_resolved: {
      approvalId: "approval-1",
      toolCallId: "tool-1",
      status: "cancelled",
      decidedBy: "user",
    },
    tool_execution_started: { toolCallId: "tool-1", mutation: "mutating" },
    tool_execution_progress: { toolCallId: "tool-1", update: { message: "writing" } },
    tool_call_completed: {
      toolCallId: "tool-1",
      outcome: "succeeded",
      result: {
        toolCallId: "tool-1",
        toolName: "write",
        content: "wrote a.ts",
        isError: false,
        metadata: { durationMs: 4 },
      },
    },
    verification_started: {
      verificationId: "verification-1",
      candidate: { modelTurnId: "turn-1", messageId: "message-1" },
    },
    verification_progress: { verificationId: "verification-1", update: { message: "running" } },
    verification_completed: {
      verificationId: "verification-1",
      outcome: "continue",
      evidence: [],
      feedback: { message: "[Verification Failed]" },
    },
  } satisfies EventData;

  it("has nineteen event types, each with the payload ADR 0002 lists", () => {
    expect(Object.keys(payloads)).toHaveLength(19);
  });

  it("declares tool and verification progress as events", () => {
    const progress: SessionEvent[] = [
      {
        sessionId: "session-1",
        sequence: 5,
        occurredAt: "2026-10-01T00:00:00.000Z",
        type: "tool_execution_progress",
        data: payloads.tool_execution_progress,
      },
      {
        sessionId: "session-1",
        sequence: 6,
        occurredAt: "2026-10-01T00:00:01.000Z",
        type: "verification_progress",
        data: payloads.verification_progress,
      },
    ];

    expect(progress.map((event) => event.type)).toEqual([
      "tool_execution_progress",
      "verification_progress",
    ]);
  });

  it("narrows an event's data on its type discriminant", () => {
    const event: SessionEvent = {
      sessionId: "session-1",
      sequence: 19,
      occurredAt: "2026-10-01T00:00:02.000Z",
      type: "session_settled",
      data: payloads.session_settled,
    };

    const outcome = event.type === "session_settled" ? event.data.result.outcome : undefined;

    expect(outcome).toBe("cancelled");
  });

  it("is immutable once emitted (compile-time)", () => {
    const event: SessionEvent = {
      sessionId: "session-1",
      sequence: 1,
      occurredAt: "2026-10-01T00:00:00.000Z",
      type: "session_started",
      data: payloads.session_started,
    };

    // @ts-expect-error events are immutable
    event.sequence = 2;

    expect(event.type).toBe("session_started");
  });

  it("records why a skipped tool call was skipped and gives it no tool result (compile-time)", () => {
    const skipped: DataOf<"tool_call_completed"> = {
      toolCallId: "tool-2",
      outcome: "skipped",
      reason: "CANCELLED",
    };
    const withResult: DataOf<"tool_call_completed"> = {
      toolCallId: "tool-2",
      outcome: "skipped",
      reason: "CANCELLED",
      // @ts-expect-error a skipped Tool Call has no Tool Result
      result: payloads.tool_call_completed.result,
    };

    expect(skipped.outcome).toBe("skipped");
    expect(withResult.outcome).toBe("skipped");
  });

  it("lets a consumer read events after a snapshot sequence", async () => {
    const settled: SessionEvent = {
      sessionId: "session-1",
      sequence: 2,
      occurredAt: "2026-10-01T00:00:02.000Z",
      type: "session_settled",
      data: payloads.session_settled,
    };
    const session: Pick<AgentSession, "events"> = {
      async *events(afterSequence = 0) {
        if (afterSequence < settled.sequence) yield settled;
      },
    };

    const seen: number[] = [];
    for await (const event of session.events(1)) seen.push(event.sequence);

    expect(seen).toEqual([2]);
  });
});

describe("public runtime surface", () => {
  it("exports types only, so the reducer and the tool call scheduler stay internal", () => {
    expect(Object.keys(surface)).toEqual([]);
  });
});
