import type {
  AssistantMessage,
  ToolCallBlock,
  ToolDeclaration,
  UserMessage,
} from "@coding-agent/ai";
import { createEventLog } from "./event-log.ts";
import type { SessionEvent, SessionEventType } from "./events.ts";
import { messageOf } from "./guards.ts";
import { readModelResponse } from "./model-response.ts";
import type { AgentFailure, AgentResult, UsageTotals } from "./result.ts";
import type { AgentSession, CommandResult, OpenSessionConfig, SessionCommand } from "./session.ts";
import type {
  AgentState,
  AssistantMessageDraft,
  AssistantMessageRef,
  ExecutingToolState,
  ModelTurnRef,
  NormalizedToolCall,
  ReadyState,
  SessionCounters,
  StreamingModelState,
} from "./state.ts";
import type { CodingTask } from "./task.ts";
import { type PreflightOutcome, preflightToolCall } from "./tool-call-preflight.ts";
import { executeTool } from "./tool-execution.ts";
import type { ApprovalDecider, ToolError, ToolResult } from "./tool-result.ts";
import { addUsage, usageOf } from "./usage.ts";
import type { VerificationDecision } from "./verification.ts";

type Refusal = Extract<CommandResult, { accepted: false }>;

const refuse = (code: Refusal["code"], message: string): Refusal => ({
  accepted: false,
  code,
  message,
});

type EventDraft = {
  [T in SessionEventType]: Pick<Extract<SessionEvent, { type: T }>, "type" | "data">;
}[SessionEventType];

type StateWithoutPhase = Omit<ReadyState, "phase">;

type SessionOutcomeFields =
  | "usage"
  | "workspaceChanged"
  | "partialChangesPossible"
  | "lastSequence";

type Settlement<R = AgentResult> = R extends AgentResult ? Omit<R, SessionOutcomeFields> : never;

interface Candidate extends AssistantMessageRef {
  readonly message: AssistantMessage;
}

type QueuedToolCall = NormalizedToolCall & { readonly providerId: string };

type PreflightPassed = Extract<PreflightOutcome, { ok: true }>;

type Approval = NonNullable<NonNullable<ToolResult["metadata"]>["approval"]>;

type ApprovalDecision =
  | { readonly decision: "allow"; readonly reason?: string }
  | { readonly decision: "deny"; readonly reason?: string };

interface PendingApprovalResolver {
  readonly approvalId: string;
  readonly toolCallId: string;
  resolve(decision: ApprovalDecision): void;
}

const rejectedResult = ({ id, name }: QueuedToolCall, error: ToolError): ToolResult => ({
  toolCallId: id,
  toolName: name,
  content: error.message,
  isError: true,
  error,
});

const denialResult = ({ id, name }: QueuedToolCall, reason?: string): ToolResult => {
  const message = reason ?? "approval denied by user";
  return {
    toolCallId: id,
    toolName: name,
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

const toolResultMessage = (providerId: string, { content, isError }: ToolResult): UserMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId: providerId, content, isError }],
});

function withoutPhase(state: AgentState): StateWithoutPhase {
  return {
    sessionId: state.sessionId,
    ...(state.task === undefined ? {} : { task: state.task }),
    transcript: state.transcript,
    usage: state.usage,
    counters: state.counters,
    activeDurationMs: state.activeDurationMs,
    workspaceChanged: state.workspaceChanged,
    partialChangesPossible: state.partialChangesPossible,
    lastSequence: state.lastSequence,
  };
}

export function createAgentSession(config: OpenSessionConfig, initial: ReadyState): AgentSession {
  const log = createEventLog();
  let state: AgentState = initial;
  let queueTail: Promise<unknown> = Promise.resolve();
  const settled = Promise.withResolvers<AgentResult>();
  const abortEffects = new AbortController();
  const model = structuredClone(config.model.identity);
  const tools: readonly ToolDeclaration[] = config.tools
    .list()
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const preflightContext = {
    tools: config.tools,
    toolNames: tools.map(({ name }) => name),
    workspace: config.workspace,
    signal: abortEffects.signal,
  };
  let pendingApproval: PendingApprovalResolver | undefined;

  function commit(next: AgentState, event: EventDraft): number {
    const occurredAt = config.clock.now();
    const sequence = log.lastSequence + 1;
    state = { ...next, lastSequence: sequence };
    log.append({ sessionId: state.sessionId, sequence, occurredAt, ...event });
    return sequence;
  }

  function terminal(result: AgentResult): AgentState {
    switch (result.outcome) {
      case "succeeded":
        return { ...withoutPhase(state), phase: "succeeded", result };
      case "failed":
        return { ...withoutPhase(state), phase: "failed", result };
      case "cancelled":
        return { ...withoutPhase(state), phase: "cancelled", result };
    }
  }

  function settle(settlement: Settlement): "settled" {
    const result: AgentResult = {
      ...settlement,
      usage: state.usage,
      workspaceChanged: state.workspaceChanged,
      partialChangesPossible: state.partialChangesPossible,
      lastSequence: log.lastSequence + 1,
    };
    commit(terminal(result), { type: "session_settled", data: { result } });
    log.close();
    settled.resolve(result);
    return "settled";
  }

  const fail = (failure: AgentFailure) => settle({ outcome: "failed", failure });

  function streaming(
    modelTurn: ModelTurnRef,
    assistantMessage: AssistantMessageDraft,
  ): StreamingModelState {
    return { ...withoutPhase(state), phase: "streaming_model", modelTurn, assistantMessage };
  }

  function afterToolCallResolved(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    remaining: readonly QueuedToolCall[],
  ): StreamingModelState | ExecutingToolState {
    if (remaining.length === 0) return streaming(modelTurn, draft);
    const [nextCall, ...rest] = remaining;
    return {
      ...withoutPhase(state),
      phase: "executing_tool",
      modelTurn,
      toolCall: nextCall as QueuedToolCall,
      queuedToolCalls: rest,
    };
  }

  const incremented = (counter: keyof SessionCounters): SessionCounters => ({
    ...state.counters,
    [counter]: state.counters[counter] + 1,
  });

  function partialMessage(draft: AssistantMessageDraft, failure: AgentFailure): AssistantMessage {
    return {
      role: "assistant",
      content: draft.blocks.map(({ text }) => ({ type: "text", text })),
      model: model.id,
      finishReason: { reason: "error", rawReason: failure.code },
    };
  }

  function queueToolCalls(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    blocks: readonly ToolCallBlock[],
  ): readonly QueuedToolCall[] {
    return blocks.map((block, queueIndex) => {
      const toolCall: QueuedToolCall = {
        id: config.ids.next("tool_call"),
        providerId: block.toolCallId,
        name: block.name,
        arguments: block.arguments,
      };
      commit(
        { ...streaming(modelTurn, draft), counters: incremented("toolCalls") },
        {
          type: "tool_call_queued",
          data: { modelTurnId: modelTurn.modelTurnId, queueIndex, toolCall },
        },
      );
      return toolCall;
    });
  }

  async function awaitUserApproval(
    modelTurn: ModelTurnRef,
    toolCall: QueuedToolCall,
    queuedToolCalls: readonly QueuedToolCall[],
    summary: string,
  ): Promise<ApprovalDecision> {
    const approvalId = config.ids.next("approval");
    const resolver = Promise.withResolvers<ApprovalDecision>();
    commit(
      {
        ...withoutPhase(state),
        phase: "awaiting_approval",
        modelTurn,
        toolCall,
        queuedToolCalls,
        approval: { approvalId, summary, policy: config.approvalPolicy },
      },
      {
        type: "approval_requested",
        data: { approvalId, toolCallId: toolCall.id, summary, policy: config.approvalPolicy },
      },
    );
    pendingApproval = { approvalId, toolCallId: toolCall.id, resolve: resolver.resolve };
    return resolver.promise;
  }

  async function resolveToolCalls(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    queue: readonly QueuedToolCall[],
  ): Promise<AgentFailure | undefined> {
    let index = 0;
    let preloadedApproval:
      | {
          preflight: PreflightPassed;
          decisionPromise: Promise<ApprovalDecision>;
        }
      | undefined;

    while (index < queue.length) {
      const toolCall = queue[index] as QueuedToolCall;
      const remaining = queue.slice(index + 1);

      let result: ToolResult;
      let outcome: "succeeded" | "failed" | "denied";
      let mutating = false;

      if (preloadedApproval !== undefined) {
        mutating = true;
        const { preflight, decisionPromise } = preloadedApproval;
        preloadedApproval = undefined;
        const decision = await decisionPromise;
        if (decision.decision === "deny") {
          result = denialResult(toolCall, decision.reason);
          outcome = "denied";
        } else {
          const approval: Approval = {
            status: "allowed",
            decidedBy: "user",
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          };
          result = await executeToolCall(
            modelTurn,
            draft,
            toolCall,
            remaining,
            preflight,
            approval,
          );
          outcome = result.isError ? "failed" : "succeeded";
        }
      } else {
        const preflight = await preflightToolCall(toolCall, preflightContext);
        mutating = preflight.ok && preflight.tool.mutation === "mutating";

        if (!preflight.ok) {
          result = rejectedResult(toolCall, preflight.error);
          outcome = "failed";
        } else if (mutating && config.approvalPolicy === "ask") {
          const decision = await awaitUserApproval(
            modelTurn,
            toolCall,
            remaining,
            preflight.prepared.summary,
          );
          if (decision.decision === "deny") {
            result = denialResult(toolCall, decision.reason);
            outcome = "denied";
          } else {
            const approval: Approval = {
              status: "allowed",
              decidedBy: "user",
              ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            };
            result = await executeToolCall(
              modelTurn,
              draft,
              toolCall,
              remaining,
              preflight,
              approval,
            );
            outcome = result.isError ? "failed" : "succeeded";
          }
        } else {
          result = await executeToolCall(modelTurn, draft, toolCall, remaining, preflight);
          outcome = result.isError ? "failed" : "succeeded";
        }
      }

      const nextCall = remaining[0];
      const nextTool = nextCall ? config.tools.get(nextCall.name) : undefined;
      const nextMightNeedApproval =
        outcome === "denied" &&
        nextCall !== undefined &&
        config.approvalPolicy === "ask" &&
        nextTool?.mutation === "mutating";

      if (nextMightNeedApproval && nextCall) {
        const nextPreflight = await preflightToolCall(nextCall, preflightContext);
        if (nextPreflight.ok && nextPreflight.tool.mutation === "mutating") {
          const nextRemaining = remaining.slice(1);
          const nextApprovalId = config.ids.next("approval");
          const nextApproval = {
            approvalId: nextApprovalId,
            summary: nextPreflight.prepared.summary,
            policy: config.approvalPolicy,
          };
          const nextResolver = Promise.withResolvers<ApprovalDecision>();
          preloadedApproval = {
            preflight: nextPreflight,
            decisionPromise: nextResolver.promise,
          };
          pendingApproval = {
            approvalId: nextApprovalId,
            toolCallId: nextCall.id,
            resolve: nextResolver.resolve,
          };

          commit(
            {
              ...withoutPhase(state),
              phase: "awaiting_approval",
              modelTurn,
              toolCall: nextCall,
              queuedToolCalls: nextRemaining,
              approval: nextApproval,
              transcript: [...state.transcript, toolResultMessage(toolCall.providerId, result)],
              counters: result.isError
                ? incremented("consecutiveRecoverableFailures")
                : { ...state.counters, consecutiveRecoverableFailures: 0 },
              partialChangesPossible: state.partialChangesPossible,
            },
            {
              type: "tool_call_completed",
              data: { toolCallId: toolCall.id, outcome, result },
            },
          );

          commit(state, {
            type: "approval_requested",
            data: {
              approvalId: nextApprovalId,
              toolCallId: nextCall.id,
              summary: nextPreflight.prepared.summary,
              policy: config.approvalPolicy,
            },
          });

          index++;
          continue;
        }
      }

      commit(
        {
          ...afterToolCallResolved(modelTurn, draft, remaining),
          transcript: [...state.transcript, toolResultMessage(toolCall.providerId, result)],
          counters: result.isError
            ? incremented("consecutiveRecoverableFailures")
            : { ...state.counters, consecutiveRecoverableFailures: 0 },
          partialChangesPossible:
            state.partialChangesPossible || (outcome === "failed" && mutating),
        },
        {
          type: "tool_call_completed",
          data: { toolCallId: toolCall.id, outcome, result },
        },
      );

      index++;
    }
    return undefined;
  }

  function approveByPolicy(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    toolCallId: string,
    summary: string,
  ): Approval {
    const approvalId = config.ids.next("approval");
    const approval: Approval = { status: "auto_approved", decidedBy: "policy" };
    commit(streaming(modelTurn, draft), {
      type: "approval_requested",
      data: { approvalId, toolCallId, summary, policy: config.approvalPolicy },
    });
    commit(streaming(modelTurn, draft), {
      type: "approval_resolved",
      data: { approvalId, toolCallId, ...approval },
    });
    return approval;
  }

  async function executeToolCall(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    toolCall: QueuedToolCall,
    queuedToolCalls: readonly QueuedToolCall[],
    { tool, prepared }: PreflightPassed,
    preApproval?: Approval,
  ): Promise<ToolResult> {
    const { mutation } = tool;
    const approval =
      preApproval ??
      (mutation === "mutating"
        ? approveByPolicy(modelTurn, draft, toolCall.id, prepared.summary)
        : undefined);
    commit(
      {
        ...withoutPhase(state),
        phase: "executing_tool",
        modelTurn,
        toolCall,
        queuedToolCalls,
        workspaceChanged: state.workspaceChanged || mutation === "mutating",
      },
      { type: "tool_execution_started", data: { toolCallId: toolCall.id, mutation } },
    );
    const startedMs = config.clock.monotonicMs();
    const outcome = await executeTool(tool, prepared, {
      workspace: config.workspace,
      signal: abortEffects.signal,
      onProgress: () => {},
    });
    const durationMs = config.clock.monotonicMs() - startedMs;
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: outcome.content,
      isError: outcome.isError,
      ...(outcome.isError ? { error: outcome.error } : {}),
      metadata: {
        durationMs,
        ...(approval === undefined ? {} : { approval }),
        ...(outcome.truncated === undefined ? {} : { truncated: outcome.truncated }),
      },
    };
  }

  async function runModelTurn(): Promise<Candidate | "continue" | "settled"> {
    const modelTurn: ModelTurnRef = {
      modelTurnId: config.ids.next("model_turn"),
      index: state.counters.modelTurns,
    };
    const { modelTurnId } = modelTurn;
    const messageId = config.ids.next("assistant_message");
    let draft: AssistantMessageDraft = { messageId, blocks: [] };

    commit(
      { ...streaming(modelTurn, draft), counters: incremented("modelTurns") },
      { type: "model_turn_started", data: { ...modelTurn, model } },
    );
    commit(streaming(modelTurn, draft), {
      type: "assistant_message_started",
      data: { modelTurnId, messageId },
    });

    const response = await readModelResponse(
      () =>
        config.model.stream(
          {
            systemPrompt: config.systemPrompt,
            messages: state.transcript.map((message) => structuredClone(message)),
            tools,
          },
          { signal: abortEffects.signal, parallelToolCalls: false },
        ),
      (blockIndex, delta) => {
        const blocks = draft.blocks.slice();
        const block = blocks[blockIndex];
        blocks[blockIndex] = { kind: "text", text: (block?.text ?? "") + delta };
        draft = { messageId, blocks };
        commit(streaming(modelTurn, draft), {
          type: "assistant_content_delta",
          data: { messageId, blockIndex, kind: "text", delta },
        });
      },
    );

    const completeTurn = (usage: UsageTotals, failure?: AgentFailure) =>
      commit(
        { ...streaming(modelTurn, draft), usage: addUsage(state.usage, usage) },
        {
          type: "model_turn_completed",
          data:
            failure === undefined
              ? { modelTurnId, outcome: "completed", usage }
              : { modelTurnId, outcome: "failed", usage, failure },
        },
      );

    if (!response.ok) {
      const { failure } = response;
      const message = response.message ?? partialMessage(draft, failure);
      commit(streaming(modelTurn, draft), {
        type: "assistant_message_completed",
        data: { messageId, outcome: "failed", message, failure },
      });
      completeTurn(usageOf(message), failure);
      return fail(failure);
    }

    const { message } = response;
    commit(
      { ...streaming(modelTurn, draft), transcript: [...state.transcript, message] },
      { type: "assistant_message_completed", data: { messageId, outcome: "completed", message } },
    );
    const toolCalls = message.content.filter((block) => block.type === "tool_call");
    if (toolCalls.length > 0) {
      const failure = await resolveToolCalls(
        modelTurn,
        draft,
        queueToolCalls(modelTurn, draft, toolCalls),
      );
      completeTurn(usageOf(message), failure);
      return failure === undefined ? "continue" : fail(failure);
    }
    commit(streaming(modelTurn, draft), {
      type: "candidate_completion_detected",
      data: { modelTurnId, messageId },
    });
    completeTurn(usageOf(message));
    return { modelTurnId, messageId, message };
  }

  async function verifyCandidate({
    message,
    ...messageRef
  }: Candidate): Promise<"continue" | "settled"> {
    const verification = {
      verificationId: config.ids.next("verification"),
      candidate: messageRef,
    };
    const { verificationId } = verification;
    commit(
      { ...withoutPhase(state), phase: "verifying", verification },
      { type: "verification_started", data: verification },
    );

    let decision: VerificationDecision;
    try {
      decision = structuredClone(
        await config.verification.verify(
          structuredClone({
            transcript: state.transcript,
            finalMessage: message,
            workspaceChanged: state.workspaceChanged,
          }),
          { signal: abortEffects.signal, onProgress: () => {} },
        ),
      );
    } catch (error) {
      commit(state, {
        type: "verification_completed",
        data: { verificationId, outcome: "failed", evidence: [] },
      });
      return fail({
        code: "INTERNAL_ERROR",
        message: `the Verification Policy threw: ${messageOf(error)}`,
      });
    }

    const summary = { outcome: decision.outcome, evidence: decision.evidence };
    switch (decision.outcome) {
      case "continue": {
        const { feedback } = decision;
        commit(
          { ...state, transcript: [...state.transcript, feedback] },
          { type: "verification_completed", data: { verificationId, ...summary, feedback } },
        );
        return "continue";
      }
      case "succeeded":
        commit(state, { type: "verification_completed", data: { verificationId, ...summary } });
        return settle({ outcome: "succeeded", finalMessage: message, verification: summary });
      case "failed":
        commit(state, { type: "verification_completed", data: { verificationId, ...summary } });
        return settle({
          outcome: "failed",
          failure: { code: "VERIFICATION_FAILED", message: decision.message },
          finalMessage: message,
          verification: summary,
        });
    }
  }

  async function run(): Promise<void> {
    for (;;) {
      const turn = await runModelTurn();
      if (turn === "settled") return;
      if (turn !== "continue" && (await verifyCandidate(turn)) === "settled") return;
    }
  }

  function start({ objective }: CodingTask): CommandResult {
    if (state.task !== undefined) {
      return refuse("ALREADY_STARTED", "the session has already started");
    }
    const task: CodingTask = { objective };
    const sequence = commit(
      { ...state, task, transcript: [{ role: "user", content: objective }] },
      { type: "session_started", data: { task } },
    );
    run().catch((error: unknown) => {
      fail({ code: "INTERNAL_ERROR", message: messageOf(error) });
    });
    return { accepted: true, sequence };
  }

  function resolveApproval(
    command: Extract<SessionCommand, { type: "resolve_approval" }>,
  ): CommandResult {
    if (pendingApproval === undefined) {
      return refuse("INVALID_STATE", `no Approval is pending while ${state.phase}`);
    }
    if (command.approvalId !== pendingApproval.approvalId) {
      return refuse(
        "STALE_APPROVAL",
        `Approval ${command.approvalId} does not match the pending Approval ${pendingApproval.approvalId}`,
      );
    }
    const nextState =
      command.decision === "allow" && state.phase === "awaiting_approval"
        ? {
            ...withoutPhase(state),
            phase: "executing_tool" as const,
            modelTurn: state.modelTurn,
            toolCall: state.toolCall,
            queuedToolCalls: state.queuedToolCalls,
          }
        : state;
    const sequence = commit(nextState, {
      type: "approval_resolved",
      data: {
        approvalId: pendingApproval.approvalId,
        toolCallId: pendingApproval.toolCallId,
        status: command.decision === "allow" ? "allowed" : "denied",
        decidedBy: "user" as ApprovalDecider,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      },
    });
    const { resolve } = pendingApproval;
    pendingApproval = undefined;
    resolve({ decision: command.decision, reason: command.reason });
    return { accepted: true, sequence };
  }

  function handle(command: SessionCommand): CommandResult {
    switch (command.type) {
      case "start":
        return start(command.task);
      case "resolve_approval":
        return resolveApproval(command);
      case "cancel":
        return state.phase === "succeeded" || state.phase === "failed"
          ? refuse("ALREADY_SETTLED", `the session has already ${state.phase}`)
          : refuse("INVALID_STATE", `cannot cancel a session in ${state.phase}`);
    }
  }

  return {
    dispatch(command) {
      const handled = queueTail.then(() => handle(command));
      queueTail = handled.catch(() => {});
      return handled;
    },
    snapshot: () => state,
    events(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new RangeError(`afterSequence must be a non-negative integer, got ${afterSequence}`);
      }
      return log.follow(afterSequence);
    },
    result: () => settled.promise,
  };
}
