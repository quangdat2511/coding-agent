import type { AssistantMessage, Model } from "@coding-agent/ai";
import type { RunLimits } from "./ports.ts";
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

export interface RunEventEnvelope<TType extends string, TData> {
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: TType;
  readonly data: Readonly<TData>;
}

export type LimitKind = Exclude<keyof RunLimits, "cancellationGraceMs">;

export type SkipReason = "CANCELLED" | AgentFailureCode;

export type ModelTurnOutcome = "completed" | "failed" | "cancelled";

export type RunStartedEvent = RunEventEnvelope<"run_started", { task: CodingTask }>;

export type CancellationRequestedEvent = RunEventEnvelope<
  "cancellation_requested",
  { reason?: string; requestedFrom: CancellablePhase }
>;

export type RuntimeLimitReachedEvent = RunEventEnvelope<
  "runtime_limit_reached",
  { kind: LimitKind; limit: number; observed: number }
>;

export type RunSettledEvent = RunEventEnvelope<"run_settled", { result: AgentResult }>;

export type ModelTurnStartedEvent = RunEventEnvelope<
  "model_turn_started",
  ModelTurnRef & { model: Model }
>;

export type AssistantMessageStartedEvent = RunEventEnvelope<
  "assistant_message_started",
  AssistantMessageRef
>;

export type AssistantContentDeltaEvent = RunEventEnvelope<
  "assistant_content_delta",
  { messageId: string; blockIndex: number; kind: DisplayContentKind; delta: string }
>;

export type AssistantMessageCompletedEvent = RunEventEnvelope<
  "assistant_message_completed",
  {
    messageId: string;
    outcome: ModelTurnOutcome;
    message: AssistantMessage;
    failure?: AgentFailure;
  }
>;

export type ModelTurnCompletedEvent = RunEventEnvelope<
  "model_turn_completed",
  { modelTurnId: string; outcome: ModelTurnOutcome; usage: UsageTotals; failure?: AgentFailure }
>;

export type CandidateCompletionDetectedEvent = RunEventEnvelope<
  "candidate_completion_detected",
  AssistantMessageRef
>;

export type ToolCallQueuedEvent = RunEventEnvelope<
  "tool_call_queued",
  { modelTurnId: string; queueIndex: number; toolCall: NormalizedToolCall }
>;

export type ApprovalRequestedEvent = RunEventEnvelope<
  "approval_requested",
  PendingApproval & { toolCallId: string }
>;

export type ApprovalResolvedEvent = RunEventEnvelope<
  "approval_resolved",
  {
    approvalId: string;
    toolCallId: string;
    status: ApprovalStatus | "cancelled";
    decidedBy: ApprovalDecider;
    reason?: string;
  }
>;

export type ToolExecutionStartedEvent = RunEventEnvelope<
  "tool_execution_started",
  { toolCallId: string; mutation: ToolMutation }
>;

export type ToolExecutionProgressEvent = RunEventEnvelope<
  "tool_execution_progress",
  { toolCallId: string; update: ToolProgress }
>;

export type ToolCallCompletedEvent = RunEventEnvelope<
  "tool_call_completed",
  | {
      toolCallId: string;
      outcome: "succeeded" | "failed" | "denied" | "cancelled";
      result?: ToolResult;
    }
  | { toolCallId: string; outcome: "skipped"; reason: SkipReason }
>;

export type VerificationStartedEvent = RunEventEnvelope<"verification_started", VerificationRun>;

export type VerificationProgressEvent = RunEventEnvelope<
  "verification_progress",
  { verificationId: string; update: VerificationProgress }
>;

export type VerificationCompletedEvent = RunEventEnvelope<
  "verification_completed",
  {
    verificationId: string;
    outcome: VerificationOutcome;
    evidence: readonly VerificationEvidence[];
    feedback?: VerificationFeedback;
  }
>;

export type RunEvent =
  | RunStartedEvent
  | CancellationRequestedEvent
  | RuntimeLimitReachedEvent
  | RunSettledEvent
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

export type RunEventType = RunEvent["type"];
