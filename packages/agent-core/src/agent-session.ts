import type {
  AssistantMessage,
  FinishReason,
  ToolCallBlock,
  ToolDeclaration,
  UserMessage,
} from "@coding-agent/ai";
import { createEventLog } from "./event-log.ts";
import type {
  ApprovalRequestedEvent,
  AssistantMessageCompletedEvent,
  AssistantMessageStartedEvent,
  ModelTurnStartedEvent,
  SessionEvent,
  SessionEventType,
  SkipReason,
  ToolCallQueuedEvent,
  VerificationStartedEvent,
} from "./events.ts";
import { isRecord, messageOf } from "./guards.ts";
import { createLimitGuard, type LimitBreach } from "./limit-guard.ts";
import { readModelResponse } from "./model-response.ts";
import type { AgentFailure, AgentResult, UsageTotals } from "./result.ts";
import type { AgentSession, CommandResult, OpenSessionConfig, SessionCommand } from "./session.ts";
import type {
  AgentPhase,
  AgentState,
  AssistantMessageDraft,
  AssistantMessageRef,
  CancellablePhase,
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
import { createProgressGate } from "./tool-progress.ts";
import type { ApprovalDecider, ToolError, ToolResult } from "./tool-result.ts";
import { addUsage, usageOf } from "./usage.ts";
import type { VerificationCancelled, VerificationDecision } from "./verification.ts";

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
  readonly draft: AssistantMessageDraft;
  resolve(decision: ApprovalDecision): void;
}

const rejectedResult = ({ id, name }: QueuedToolCall, error: ToolError): ToolResult => ({
  toolCallId: id,
  toolName: name,
  content: error.message,
  isError: true,
  error,
});

const normalizeReason = (reason?: string): string | undefined => {
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const denialResult = ({ id, name }: QueuedToolCall, rawReason?: string): ToolResult => {
  const reason = normalizeReason(rawReason);
  const message = reason ?? "approval denied by user";
  return {
    toolCallId: id,
    toolName: name,
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
  const guard = createLimitGuard(config.limits, config.clock);
  let state: AgentState = initial;
  const phase = (): AgentPhase => state.phase;
  const isTerminal = (): boolean =>
    state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";

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
  let currentDraft: AssistantMessageDraft | undefined;
  let currentFailedMessage: AssistantMessage | undefined;
  let cancellationReason: string | undefined;
  let cancelGraceTimer: (() => void) | undefined;
  let deadlineTimer: (() => void) | undefined;
  let breachedLimit: LimitBreach | undefined;
  let limitEventCommitted = false;

  const SAFE_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
  let lastOccurredAt: string | undefined;
  let isClosingWork = false;

  function commit(next: AgentState, event: EventDraft): number {
    let occurredAt: string;
    try {
      occurredAt = config.clock.now();
      lastOccurredAt = occurredAt;
    } catch (error) {
      if (
        isClosingWork ||
        isCancellingOrTerminal() ||
        next.phase === "cancelling" ||
        next.phase === "failed" ||
        event.type === "session_settled" ||
        event.type === "runtime_limit_reached"
      ) {
        occurredAt = lastOccurredAt ?? SAFE_FALLBACK_TIMESTAMP;
      } else {
        throw error;
      }
    }
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

  function commitModelTurnCompleted(
    modelTurnId: string,
    outcome: "completed" | "failed" | "cancelled",
    usage: UsageTotals,
    failure?: AgentFailure,
    baseState: AgentState = state,
  ): void {
    commit(
      { ...baseState, usage: addUsage(state.usage, usage) },
      {
        type: "model_turn_completed",
        data: {
          modelTurnId,
          outcome,
          usage,
          ...(failure !== undefined ? { failure } : {}),
        },
      },
    );
  }

  function startGraceTimer(): void {
    if (cancelGraceTimer !== undefined) return;
    cancelGraceTimer = config.clock.setTimer(config.limits.cancellationGraceMs, () => {
      cancelGraceTimer = undefined;
      if (!isTerminal()) {
        if (breachedLimit !== undefined) {
          breachLimit(breachedLimit);
          return;
        }
        closeActiveWork({
          kind: "failed",
          failure: {
            code: "CANCELLATION_TIMEOUT",
            message: `cancellation grace period of ${config.limits.cancellationGraceMs}ms expired while waiting for active work to quiesce`,
          },
        });
      }
    });
  }

  function clearGraceTimer(): void {
    if (cancelGraceTimer !== undefined) {
      cancelGraceTimer();
      cancelGraceTimer = undefined;
    }
  }

  function clearDeadlineTimer(): void {
    if (deadlineTimer !== undefined) {
      deadlineTimer();
      deadlineTimer = undefined;
    }
  }

  function commitLimitReached(breach: LimitBreach): void {
    if (limitEventCommitted) return;
    commit(state, {
      type: "runtime_limit_reached",
      data: { kind: breach.kind, limit: breach.limit, observed: breach.observed },
    });
    limitEventCommitted = true;
  }

  function recordDurationBreach(
    options: { readonly assumeExpiredOnClockFailure?: boolean } = {},
  ): LimitBreach | undefined {
    if (breachedLimit !== undefined || isCancellingOrTerminal()) return breachedLimit;
    let breach: LimitBreach | undefined;
    try {
      breach = guard.checkDuration();
    } catch (error) {
      if (!options.assumeExpiredOnClockFailure) throw error;
      breach = {
        kind: "maxDurationMs",
        limit: config.limits.maxDurationMs,
        observed: config.limits.maxDurationMs,
      };
    }
    if (breach === undefined) return undefined;
    breachedLimit = breach;
    commitLimitReached(breach);
    abortEffects.abort();
    return breach;
  }

  function armDeadlineTimer(): void {
    clearDeadlineTimer();
    const remaining = guard.remainingMs();
    if (remaining <= 0) {
      recordDurationBreach();
      return;
    }
    deadlineTimer = config.clock.setTimer(remaining, () => {
      deadlineTimer = undefined;
      if (recordDurationBreach({ assumeExpiredOnClockFailure: true }) !== undefined) {
        startGraceTimer();
      }
    });
  }

  type DeadlineOutcome<T> =
    | { readonly kind: "completed"; readonly value: T }
    | { readonly kind: "breached"; readonly breach: LimitBreach };

  async function runUnderDeadline<T>(effect: () => Promise<T>): Promise<DeadlineOutcome<T>> {
    recordDurationBreach();
    if (breachedLimit !== undefined) return { kind: "breached", breach: breachedLimit };

    armDeadlineTimer();
    if (breachedLimit !== undefined) return { kind: "breached", breach: breachedLimit };

    let value: T;
    try {
      value = await effect();
    } finally {
      recordDurationBreach();
      clearDeadlineTimer();
    }

    if (breachedLimit !== undefined) return { kind: "breached", breach: breachedLimit };
    return { kind: "completed", value };
  }

  function settle(settlement: Settlement): "settled" {
    if (isTerminal()) {
      return "settled";
    }
    clearGraceTimer();
    clearDeadlineTimer();
    guard.pause();
    const activeDurationMs = guard.elapsed();
    const partialChangesPossible =
      state.partialChangesPossible ||
      (settlement.outcome !== "succeeded" && state.workspaceChanged);
    const result: AgentResult = {
      ...settlement,
      usage: state.usage,
      workspaceChanged: state.workspaceChanged,
      partialChangesPossible,
      lastSequence: log.lastSequence + 1,
    };
    try {
      commit(
        { ...terminal(result), activeDurationMs, partialChangesPossible },
        { type: "session_settled", data: { result } },
      );
    } finally {
      log.close();
      settled.resolve(result);
    }
    return "settled";
  }

  const fail = (failure: AgentFailure) => settle({ outcome: "failed", failure });

  type CloseMode =
    | { readonly kind: "cancel"; readonly reason?: string }
    | { readonly kind: "failed"; readonly failure: AgentFailure };

  function resolvePendingApproval(mode: CloseMode): void {
    const events = log.events();
    const requested = events.findLast(
      (e): e is ApprovalRequestedEvent => e.type === "approval_requested",
    );
    if (requested === undefined) {
      return;
    }
    const resolved = events.some(
      (e) => e.type === "approval_resolved" && e.data.approvalId === requested.data.approvalId,
    );
    if (resolved) {
      return;
    }

    const isCancel = mode.kind === "cancel";
    const { approvalId, toolCallId } = requested.data;
    commit(state, {
      type: "approval_resolved",
      data: {
        approvalId,
        toolCallId,
        status: "cancelled",
        decidedBy: isCancel ? "user" : "policy",
        ...(isCancel && mode.reason !== undefined
          ? { reason: mode.reason }
          : mode.kind === "failed"
            ? { reason: mode.failure.message }
            : {}),
      },
    });

    if (pendingApproval !== undefined) {
      const { resolve } = pendingApproval;
      pendingApproval = undefined;
      resolve({
        decision: "deny",
        ...(isCancel ? { reason: "cancelled" } : { reason: mode.failure.message }),
      });
    }
  }

  function closeModelTurn(
    mode: CloseMode,
    outcome: "cancelled" | "failed",
    skipReason: SkipReason,
  ): void {
    const events = log.events();
    const turnStartedIndex = events.findLastIndex((e) => e.type === "model_turn_started");
    if (turnStartedIndex === -1) {
      return;
    }
    const turnStarted = events[turnStartedIndex] as ModelTurnStartedEvent;
    const turnCompleted = events.some(
      (e) =>
        e.type === "model_turn_completed" && e.data.modelTurnId === turnStarted.data.modelTurnId,
    );
    if (turnCompleted) {
      return;
    }

    const turnEvents = events.slice(turnStartedIndex);

    const queuedEvents = turnEvents.filter(
      (e): e is ToolCallQueuedEvent => e.type === "tool_call_queued",
    );
    for (const queued of queuedEvents) {
      const { toolCall } = queued.data;
      const completed = events.some(
        (e) => e.type === "tool_call_completed" && e.data.toolCallId === toolCall.id,
      );
      if (!completed) {
        const started = events.some(
          (e) => e.type === "tool_execution_started" && e.data.toolCallId === toolCall.id,
        );
        if (started) {
          commit(state, {
            type: "tool_call_completed",
            data: {
              toolCallId: toolCall.id,
              outcome,
            },
          });
        } else {
          commit(state, {
            type: "tool_call_completed",
            data: {
              toolCallId: toolCall.id,
              outcome: "skipped",
              reason: skipReason,
            },
          });
        }
      }
    }

    const msgStarted = turnEvents.find(
      (e): e is AssistantMessageStartedEvent => e.type === "assistant_message_started",
    );
    const msgCompleted = events.find(
      (e): e is AssistantMessageCompletedEvent =>
        e.type === "assistant_message_completed" &&
        (msgStarted !== undefined ? e.data.messageId === msgStarted.data.messageId : false),
    );

    let messageUsage: UsageTotals = { inputTokens: 0, outputTokens: 0 };

    if (msgStarted !== undefined && msgCompleted === undefined) {
      const message =
        currentFailedMessage ??
        partialMessage(
          currentDraft ?? { messageId: msgStarted.data.messageId, blocks: [] },
          mode.kind === "cancel" ? { reason: "other", rawReason: "cancelled" } : mode.failure,
        );
      commit(state, {
        type: "assistant_message_completed",
        data: {
          messageId: msgStarted.data.messageId,
          outcome,
          message,
          ...(mode.kind === "failed" ? { failure: mode.failure } : {}),
        },
      });
      messageUsage = usageOf(message);
    } else if (msgCompleted !== undefined) {
      messageUsage = usageOf(msgCompleted.data.message);
    }

    commitModelTurnCompleted(
      turnStarted.data.modelTurnId,
      outcome,
      messageUsage,
      mode.kind === "failed" ? mode.failure : undefined,
    );

    currentDraft = undefined;
    currentFailedMessage = undefined;
  }

  function closeVerification(outcome: "cancelled" | "failed"): void {
    const events = log.events();
    const verStarted = events.findLast(
      (e): e is VerificationStartedEvent => e.type === "verification_started",
    );
    if (verStarted === undefined) {
      return;
    }
    const verCompleted = events.some(
      (e) =>
        e.type === "verification_completed" &&
        e.data.verificationId === verStarted.data.verificationId,
    );
    if (verCompleted) {
      return;
    }
    commit(state, {
      type: "verification_completed",
      data: {
        verificationId: verStarted.data.verificationId,
        outcome,
        evidence: [],
      },
    });
  }

  function settleTerminal(mode: CloseMode): void {
    if (mode.kind === "cancel") {
      settle({
        outcome: "cancelled",
        cancellation: { ...(mode.reason === undefined ? {} : { reason: mode.reason }) },
      });
    } else {
      fail(mode.failure);
    }
  }

  function closeActiveWork(mode: CloseMode): void {
    if (isTerminal()) {
      return;
    }
    isClosingWork = true;
    clearGraceTimer();
    clearDeadlineTimer();

    const outcome = mode.kind === "cancel" ? "cancelled" : "failed";
    const skipReason: SkipReason = mode.kind === "cancel" ? "CANCELLED" : mode.failure.code;

    resolvePendingApproval(mode);
    closeModelTurn(mode, outcome, skipReason);
    closeVerification(outcome);
    settleTerminal(mode);
  }

  function breachLimit(breach: LimitBreach): "settled" {
    if (isTerminal()) return "settled";
    commitLimitReached(breach);
    closeActiveWork({
      kind: "failed",
      failure: {
        code: "LIMIT_EXCEEDED",
        message: `session limit ${breach.kind} exhausted: observed ${breach.observed}, limit ${breach.limit}`,
        details: { kind: breach.kind, limit: breach.limit, observed: breach.observed },
      },
    });
    return "settled";
  }

  const isCancellingOrTerminal = (): boolean => isTerminal() || phase() === "cancelling";

  function settleIfCancelling(): boolean {
    if (isTerminal()) {
      return true;
    }
    if (phase() === "cancelling") {
      closeActiveWork({ kind: "cancel", reason: cancellationReason });
      return true;
    }
    return false;
  }

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

  function partialMessage(
    draft: AssistantMessageDraft,
    reasonOrFailure: FinishReason | AgentFailure,
  ): AssistantMessage {
    const finishReason: FinishReason =
      "reason" in reasonOrFailure
        ? reasonOrFailure
        : { reason: "error", rawReason: reasonOrFailure.code };
    return {
      role: "assistant",
      content: draft.blocks.map(({ text }) => ({ type: "text", text })),
      model: model.id,
      finishReason,
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
      commit(streaming(modelTurn, draft), {
        type: "tool_call_queued",
        data: { modelTurnId: modelTurn.modelTurnId, queueIndex, toolCall },
      });
      return toolCall;
    });
  }

  async function awaitUserApproval(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    toolCall: QueuedToolCall,
    queuedToolCalls: readonly QueuedToolCall[],
    summary: string,
  ): Promise<ApprovalDecision> {
    guard.pause();
    const breach = guard.checkBeforeToolExecution(state.counters);
    if (breach !== undefined) {
      breachLimit(breach);
      return { decision: "deny", reason: "session limit reached" };
    }
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
    pendingApproval = { approvalId, toolCallId: toolCall.id, draft, resolve: resolver.resolve };
    return resolver.promise;
  }

  async function resolveToolCalls(
    modelTurn: ModelTurnRef,
    draft: AssistantMessageDraft,
    queue: readonly QueuedToolCall[],
  ): Promise<AgentFailure | "settled" | undefined> {
    for (const [index, toolCall] of queue.entries()) {
      if (isCancellingOrTerminal()) {
        return undefined;
      }

      const breach = guard.checkBeforeToolExecution(state.counters);
      if (breach !== undefined) {
        breachLimit(breach);
        return "settled";
      }

      const preparation = await runUnderDeadline(() =>
        preflightToolCall(toolCall, preflightContext),
      );
      if (preparation.kind === "breached") {
        breachLimit(preparation.breach);
        return "settled";
      }
      const preflight = preparation.value;

      if (isCancellingOrTerminal()) {
        return undefined;
      }

      const preflightBreach = guard.checkBeforeToolExecution(state.counters);
      if (preflightBreach !== undefined) {
        breachLimit(preflightBreach);
        return "settled";
      }

      const mutating = preflight.ok && preflight.tool.mutation === "mutating";
      const remaining = queue.slice(index + 1);

      let result: ToolResult;
      let outcome: "succeeded" | "failed" | "denied";
      let countedAtExecutionStart = false;

      if (!preflight.ok) {
        result = rejectedResult(toolCall, preflight.error);
        outcome = "failed";
      } else if (mutating && config.approvalPolicy === "ask") {
        const decision = await awaitUserApproval(
          modelTurn,
          draft,
          toolCall,
          remaining,
          preflight.prepared.summary,
        );
        if (isCancellingOrTerminal()) {
          return undefined;
        }
        if (decision.decision === "deny") {
          result = denialResult(toolCall, decision.reason);
          outcome = "denied";
        } else {
          const approval: Approval = {
            status: "allowed",
            decidedBy: "user",
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          };
          const execution = await runUnderDeadline(() =>
            executeToolCall(modelTurn, draft, toolCall, remaining, preflight, approval),
          );
          if (execution.kind === "breached") {
            breachLimit(execution.breach);
            return "settled";
          }
          result = execution.value;
          countedAtExecutionStart = true;
          if (isCancellingOrTerminal()) {
            return undefined;
          }
          outcome = result.isError ? "failed" : "succeeded";
        }
      } else {
        const execution = await runUnderDeadline(() =>
          executeToolCall(modelTurn, draft, toolCall, remaining, preflight),
        );
        if (execution.kind === "breached") {
          breachLimit(execution.breach);
          return "settled";
        }
        result = execution.value;
        countedAtExecutionStart = true;
        if (isCancellingOrTerminal()) {
          return undefined;
        }
        outcome = result.isError ? "failed" : "succeeded";
      }

      commit(
        {
          ...afterToolCallResolved(modelTurn, draft, remaining),
          transcript: [...state.transcript, toolResultMessage(toolCall.providerId, result)],
          counters: {
            ...state.counters,
            toolCalls: state.counters.toolCalls + (countedAtExecutionStart ? 0 : 1),
            consecutiveRecoverableFailures: result.isError
              ? state.counters.consecutiveRecoverableFailures + 1
              : 0,
          },
          partialChangesPossible:
            state.partialChangesPossible || (outcome === "failed" && mutating),
        },
        {
          type: "tool_call_completed",
          data: { toolCallId: toolCall.id, outcome, result },
        },
      );

      const failureBreach = guard.checkAfterToolResult(state.counters);
      if (failureBreach !== undefined) {
        breachLimit(failureBreach);
        return "settled";
      }
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
        counters: incremented("toolCalls"),
        workspaceChanged: state.workspaceChanged || mutation === "mutating",
      },
      { type: "tool_execution_started", data: { toolCallId: toolCall.id, mutation } },
    );
    const startedMs = config.clock.monotonicMs();
    // ADR 0002 permits progress only between tool_execution_started and tool_call_completed, so
    // the gate closes before the result is committed and later updates are ignored. The phase
    // check covers a Tool Call completed while execute still runs, as when cancellation's grace
    // period expires: no update may follow its tool_call_completed or session_settled.
    const progress = createProgressGate(config.clock, (output) => {
      if (
        breachedLimit !== undefined ||
        state.phase !== "executing_tool" ||
        state.toolCall.id !== toolCall.id
      ) {
        return;
      }
      commit(state, {
        type: "tool_execution_progress",
        data: { toolCallId: toolCall.id, update: { output } },
      });
    });
    const outcome = await executeTool(tool, prepared, {
      workspace: config.workspace,
      signal: abortEffects.signal,
      onProgress: (update) => {
        // Checked at run time like the outcome; an update that is not Tool Progress is dropped,
        // because progress is advisory and must not fail the call (ADR 0004 §3).
        if (isRecord(update) && typeof update.output === "string") progress.report(update.output);
      },
    });
    progress.close();
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
    if (settleIfCancelling()) {
      return "settled";
    }

    const modelTurn: ModelTurnRef = {
      modelTurnId: config.ids.next("model_turn"),
      index: state.counters.modelTurns,
    };
    const { modelTurnId } = modelTurn;
    const messageId = config.ids.next("assistant_message");
    let draft: AssistantMessageDraft = { messageId, blocks: [] };
    currentDraft = draft;

    commit(
      { ...streaming(modelTurn, draft), counters: incremented("modelTurns") },
      { type: "model_turn_started", data: { ...modelTurn, model } },
    );
    commit(streaming(modelTurn, draft), {
      type: "assistant_message_started",
      data: { modelTurnId, messageId },
    });

    const modelResponse = await runUnderDeadline(() =>
      readModelResponse(
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
          if (breachedLimit !== undefined || state.phase !== "streaming_model") return;
          const blocks = draft.blocks.slice();
          const block = blocks[blockIndex];
          blocks[blockIndex] = { kind: "text", text: (block?.text ?? "") + delta };
          draft = { messageId, blocks };
          currentDraft = draft;
          commit(streaming(modelTurn, draft), {
            type: "assistant_content_delta",
            data: { messageId, blockIndex, kind: "text", delta },
          });
        },
      ),
    );
    if (modelResponse.kind === "breached") {
      breachLimit(modelResponse.breach);
      return "settled";
    }
    const response = modelResponse.value;

    if (settleIfCancelling()) {
      return "settled";
    }

    const completeTurn = (usage: UsageTotals, failure?: AgentFailure) => {
      commitModelTurnCompleted(
        modelTurnId,
        failure === undefined ? "completed" : "failed",
        usage,
        failure,
        streaming(modelTurn, draft),
      );
    };

    if (!response.ok) {
      const { failure } = response;
      const message = response.message ?? partialMessage(draft, failure);
      currentFailedMessage = message;
      closeActiveWork({ kind: "failed", failure });
      return "settled";
    }

    const { message } = response;
    commit(
      { ...streaming(modelTurn, draft), transcript: [...state.transcript, message] },
      { type: "assistant_message_completed", data: { messageId, outcome: "completed", message } },
    );

    if (settleIfCancelling()) {
      return "settled";
    }

    const toolCalls = message.content.filter((block) => block.type === "tool_call");
    if (toolCalls.length > 0) {
      const queued = queueToolCalls(modelTurn, draft, toolCalls);
      const failure = await resolveToolCalls(modelTurn, draft, queued);
      if (failure === "settled" || settleIfCancelling()) {
        return "settled";
      }
      completeTurn(usageOf(message), failure);
      currentDraft = undefined;
      currentFailedMessage = undefined;
      return failure === undefined ? "continue" : fail(failure);
    }

    commit(streaming(modelTurn, draft), {
      type: "candidate_completion_detected",
      data: { modelTurnId, messageId },
    });
    completeTurn(usageOf(message));
    currentDraft = undefined;
    currentFailedMessage = undefined;
    return { modelTurnId, messageId, message };
  }

  // A Verification Policy that throws or breaks its contract fails the session: neither is a
  // decision the session can act on.
  function failInternal(message: string): "settled" {
    closeActiveWork({ kind: "failed", failure: { code: "INTERNAL_ERROR", message } });
    return "settled";
  }

  async function verifyCandidate({
    message,
    ...messageRef
  }: Candidate): Promise<"continue" | "settled"> {
    if (settleIfCancelling()) {
      return "settled";
    }
    const breach = guard.checkBeforeVerification();
    if (breach !== undefined) {
      breachLimit(breach);
      return "settled";
    }
    const verification = {
      verificationId: config.ids.next("verification"),
      candidate: messageRef,
    };
    const { verificationId } = verification;
    commit(
      { ...withoutPhase(state), phase: "verifying", verification },
      { type: "verification_started", data: verification },
    );

    let verificationResult: DeadlineOutcome<VerificationDecision | VerificationCancelled>;
    try {
      verificationResult = await runUnderDeadline(async () =>
        structuredClone(
          await config.verification.verify(
            structuredClone({
              transcript: state.transcript,
              finalMessage: message,
              workspaceChanged: state.workspaceChanged,
            }),
            { signal: abortEffects.signal, onProgress: () => {} },
          ),
        ),
      );
    } catch (error) {
      if (breachedLimit !== undefined) {
        breachLimit(breachedLimit);
        return "settled";
      }
      if (settleIfCancelling()) {
        return "settled";
      }
      return failInternal(`the Verification Policy threw: ${messageOf(error)}`);
    }
    if (verificationResult.kind === "breached") {
      breachLimit(verificationResult.breach);
      return "settled";
    }
    const decision = verificationResult.value;

    if (settleIfCancelling()) {
      return "settled";
    }
    // Only Agent Core aborts the signal, and only after a cancel it accepted, so a cancellation
    // reported outside cancelling breaks the policy's contract.
    if (decision.outcome === "cancelled") {
      return failInternal("the Verification Policy reported a cancellation that was not requested");
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
      if (isTerminal()) {
        return;
      }
      if (settleIfCancelling()) {
        return;
      }
      const breach = guard.checkBeforeModelTurn(state.counters);
      if (breach !== undefined) {
        breachLimit(breach);
        return;
      }
      const turn = await runModelTurn();
      if (turn === "settled" || isTerminal()) {
        return;
      }
      if (turn !== "continue") {
        if (settleIfCancelling()) {
          return;
        }
        const verified = await verifyCandidate(turn);
        if (verified === "settled" || isTerminal()) {
          return;
        }
      }
    }
  }

  function start({ objective }: CodingTask): CommandResult {
    if (state.phase !== "ready" || state.task !== undefined) {
      return state.task !== undefined
        ? refuse("ALREADY_STARTED", "the session has already started")
        : refuse("INVALID_STATE", `the session is in ${state.phase}`);
    }
    const task: CodingTask = { objective };
    const sequence = commit(
      { ...state, task, transcript: [{ role: "user", content: objective }] },
      { type: "session_started", data: { task } },
    );
    try {
      guard.resume();
    } catch (error) {
      closeActiveWork({
        kind: "failed",
        failure: { code: "INTERNAL_ERROR", message: messageOf(error) },
      });
      return { accepted: true, sequence };
    }
    run().catch((error: unknown) => {
      if (breachedLimit !== undefined) {
        breachLimit(breachedLimit);
        return;
      }
      if (settleIfCancelling()) {
        return;
      }
      closeActiveWork({
        kind: "failed",
        failure: { code: "INTERNAL_ERROR", message: messageOf(error) },
      });
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
    const reason = normalizeReason(command.reason);
    const nextState =
      state.phase === "awaiting_approval"
        ? command.decision === "deny" && state.queuedToolCalls.length === 0
          ? streaming(state.modelTurn, pendingApproval.draft)
          : {
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
        ...(reason === undefined ? {} : { reason }),
      },
    });
    const { resolve } = pendingApproval;
    pendingApproval = undefined;
    try {
      guard.resume();
    } catch (error) {
      resolve({ decision: command.decision, ...(reason === undefined ? {} : { reason }) });
      closeActiveWork({
        kind: "failed",
        failure: { code: "INTERNAL_ERROR", message: messageOf(error) },
      });
      return { accepted: true, sequence };
    }
    resolve({ decision: command.decision, ...(reason === undefined ? {} : { reason }) });
    return { accepted: true, sequence };
  }

  function handle(command: SessionCommand): CommandResult {
    switch (command.type) {
      case "start":
        return start(command.task);
      case "resolve_approval":
        return resolveApproval(command);
      case "cancel": {
        if (state.phase === "succeeded" || state.phase === "failed") {
          return refuse("ALREADY_SETTLED", `the session has already ${state.phase}`);
        }
        if (
          breachedLimit !== undefined ||
          state.phase === "cancelling" ||
          state.phase === "cancelled"
        ) {
          return { accepted: true, sequence: state.lastSequence };
        }

        const requestedFrom = state.phase as CancellablePhase;
        const reason = normalizeReason(command.reason);
        cancellationReason = reason;

        const partialChangesPossible = state.partialChangesPossible || state.workspaceChanged;
        const sequence = commit(
          {
            ...withoutPhase(state),
            phase: "cancelling",
            requestedFrom,
            partialChangesPossible,
            ...(reason === undefined ? {} : { reason }),
          },
          {
            type: "cancellation_requested",
            data: {
              requestedFrom,
              ...(reason === undefined ? {} : { reason }),
            },
          },
        );

        clearDeadlineTimer();
        abortEffects.abort();

        if (requestedFrom === "ready" || requestedFrom === "awaiting_approval") {
          closeActiveWork({ kind: "cancel", reason });
        } else {
          startGraceTimer();
        }

        return { accepted: true, sequence };
      }
    }
  }

  return {
    dispatch(command) {
      const handled = queueTail.then(() => handle(command));
      queueTail = handled.catch(() => {});
      return handled;
    },
    snapshot: () => ({ ...state, activeDurationMs: guard.elapsed() }),
    events(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new RangeError(`afterSequence must be a non-negative integer, got ${afterSequence}`);
      }
      return log.follow(afterSequence);
    },
    result: () => settled.promise,
  };
}
