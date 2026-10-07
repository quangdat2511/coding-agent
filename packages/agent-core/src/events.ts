import type { AssistantMessage, Model } from "@coding-agent/ai";
import type { SessionLimits } from "./ports.ts";
import type { AgentFailure, AgentFailureCode, AgentResult, UsageTotals } from "./result.ts";
import type {
  AssistantMessageRef,
  CancellablePhase,
  DisplayContentKind,
  ModelTurnRef,
  NormalizedToolCall,
  PendingApproval,
  VerificationRun,
} from "./state.ts";
import type { CodingTask } from "./task.ts";
import type { ToolMutation } from "./tool.ts";
import type { ApprovalDecider, ApprovalStatus, ToolProgress, ToolResult } from "./tool-result.ts";
import type {
  VerificationEvidence,
  VerificationFeedback,
  VerificationOutcome,
  VerificationProgress,
} from "./verification.ts";

export interface SessionEventEnvelope<TType extends string, TData> {
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: TType;
  readonly data: Readonly<TData>;
}

export type LimitKind = Exclude<keyof SessionLimits, "cancellationGraceMs">;

export type SkipReason = "CANCELLED" | AgentFailureCode;

export type ModelTurnOutcome = "completed" | "failed" | "cancelled";

export type SessionStartedEvent = SessionEventEnvelope<"session_started", { task: CodingTask }>;

export type CancellationRequestedEvent = SessionEventEnvelope<
  "cancellation_requested",
  { reason?: string; requestedFrom: CancellablePhase }
>;

export type RuntimeLimitReachedEvent = SessionEventEnvelope<
  "runtime_limit_reached",
  { kind: LimitKind; limit: number; observed: number }
>;

export type SessionSettledEvent = SessionEventEnvelope<"session_settled", { result: AgentResult }>;

export type ModelTurnStartedEvent = SessionEventEnvelope<
  "model_turn_started",
  ModelTurnRef & { model: Model }
>;

export type AssistantMessageStartedEvent = SessionEventEnvelope<
  "assistant_message_started",
  AssistantMessageRef
>;

export type AssistantContentDeltaEvent = SessionEventEnvelope<
  "assistant_content_delta",
  { messageId: string; blockIndex: number; kind: DisplayContentKind; delta: string }
>;

export type AssistantMessageCompletedEvent = SessionEventEnvelope<
  "assistant_message_completed",
  {
    messageId: string;
    outcome: ModelTurnOutcome;
    message: AssistantMessage;
    failure?: AgentFailure;
  }
>;

export type ModelTurnCompletedEvent = SessionEventEnvelope<
  "model_turn_completed",
  { modelTurnId: string; outcome: ModelTurnOutcome; usage: UsageTotals; failure?: AgentFailure }
>;

export type CandidateCompletionDetectedEvent = SessionEventEnvelope<
  "candidate_completion_detected",
  AssistantMessageRef
>;

export type ToolCallQueuedEvent = SessionEventEnvelope<
  "tool_call_queued",
  { modelTurnId: string; queueIndex: number; toolCall: NormalizedToolCall }
>;

export type ApprovalRequestedEvent = SessionEventEnvelope<
  "approval_requested",
  PendingApproval & { toolCallId: string }
>;

export type ApprovalResolvedEvent = SessionEventEnvelope<
  "approval_resolved",
  {
    approvalId: string;
    toolCallId: string;
    status: ApprovalStatus | "cancelled";
    decidedBy: ApprovalDecider;
    reason?: string;
  }
>;

export type ToolExecutionStartedEvent = SessionEventEnvelope<
  "tool_execution_started",
  { toolCallId: string; mutation: ToolMutation }
>;

export type ToolExecutionProgressEvent = SessionEventEnvelope<
  "tool_execution_progress",
  { toolCallId: string; update: ToolProgress }
>;

export type ToolCallCompletedEvent = SessionEventEnvelope<
  "tool_call_completed",
  | {
      toolCallId: string;
      outcome: "succeeded" | "failed" | "denied" | "cancelled";
      result?: ToolResult;
    }
  | { toolCallId: string; outcome: "skipped"; reason: SkipReason }
>;

export type VerificationStartedEvent = SessionEventEnvelope<
  "verification_started",
  VerificationRun
>;

export type VerificationProgressEvent = SessionEventEnvelope<
  "verification_progress",
  { verificationId: string; update: VerificationProgress }
>;

export type VerificationCompletedEvent = SessionEventEnvelope<
  "verification_completed",
  {
    verificationId: string;
    outcome: VerificationOutcome;
    evidence: readonly VerificationEvidence[];
    feedback?: VerificationFeedback;
  }
>;

export type SessionEvent =
  | SessionStartedEvent
  | CancellationRequestedEvent
  | RuntimeLimitReachedEvent
  | SessionSettledEvent
  | ModelTurnStartedEvent
  | AssistantMessageStartedEvent
  | AssistantContentDeltaEvent
  | AssistantMessageCompletedEvent
  | ModelTurnCompletedEvent
  | CandidateCompletionDetectedEvent
  | ToolCallQueuedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolExecutionStartedEvent
  | ToolExecutionProgressEvent
  | ToolCallCompletedEvent
  | VerificationStartedEvent
  | VerificationProgressEvent
  | VerificationCompletedEvent;

export type SessionEventType = SessionEvent["type"];
