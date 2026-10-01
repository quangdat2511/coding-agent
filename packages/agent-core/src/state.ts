import type { Message } from "@coding-agent/ai";
import type { ApprovalPolicy } from "@/ports";
import type { CancelledResult, FailedResult, SucceededResult, UsageTotals } from "@/result";
import type { CodingTask } from "@/task";

export interface NormalizedToolCall {
  readonly id: string;
  readonly providerId?: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ModelTurnRef {
  readonly modelTurnId: string;
  readonly index: number;
}

export interface AssistantMessageRef {
  readonly modelTurnId: string;
  readonly messageId: string;
}

export interface VerificationRun {
  readonly verificationId: string;
  readonly candidate: AssistantMessageRef;
}

export interface PendingApproval {
  readonly approvalId: string;
  readonly summary: string;
  readonly policy: ApprovalPolicy;
}

export type DisplayContentKind = "text" | "reasoning";

export interface DisplayBlock {
  readonly kind: DisplayContentKind;
  readonly text: string;
}

export interface AssistantMessageDraft {
  readonly messageId: string;
  readonly blocks: readonly DisplayBlock[];
}

export interface SessionCounters {
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly consecutiveRecoverableFailures: number;
}

interface AgentStateCommon {
  readonly sessionId: string;
  readonly task?: CodingTask;
  readonly transcript: readonly Message[];
  readonly usage: UsageTotals;
  readonly counters: SessionCounters;
  readonly activeDurationMs: number;
  readonly workspaceChanged: boolean;
  readonly partialChangesPossible: boolean;
  readonly lastSequence: number;
}

export interface ReadyState extends AgentStateCommon {
  readonly phase: "ready";
}

export interface StreamingModelState extends AgentStateCommon {
  readonly phase: "streaming_model";
  readonly modelTurn: ModelTurnRef;
  readonly assistantMessage: AssistantMessageDraft;
}

export interface AwaitingApprovalState extends AgentStateCommon {
  readonly phase: "awaiting_approval";
  readonly modelTurn: ModelTurnRef;
  readonly toolCall: NormalizedToolCall;
  readonly queuedToolCalls: readonly NormalizedToolCall[];
  readonly approval: PendingApproval;
}

export interface ExecutingToolState extends AgentStateCommon {
  readonly phase: "executing_tool";
  readonly modelTurn: ModelTurnRef;
  readonly toolCall: NormalizedToolCall;
  readonly queuedToolCalls: readonly NormalizedToolCall[];
}

export interface VerifyingState extends AgentStateCommon {
  readonly phase: "verifying";
  readonly verification: VerificationRun;
}

export interface CancellingState extends AgentStateCommon {
  readonly phase: "cancelling";
  readonly requestedFrom: CancellablePhase;
  readonly reason?: string;
}

export interface SucceededState extends AgentStateCommon {
  readonly phase: "succeeded";
  readonly result: SucceededResult;
}

export interface FailedState extends AgentStateCommon {
  readonly phase: "failed";
  readonly result: FailedResult;
}

export interface CancelledState extends AgentStateCommon {
  readonly phase: "cancelled";
  readonly result: CancelledResult;
}

export type AgentState =
  | ReadyState
  | StreamingModelState
  | AwaitingApprovalState
  | ExecutingToolState
  | VerifyingState
  | CancellingState
  | SucceededState
  | FailedState
  | CancelledState;

export type AgentPhase = AgentState["phase"];

export type CancellablePhase = Exclude<
  AgentPhase,
  "cancelling" | "succeeded" | "failed" | "cancelled"
>;
