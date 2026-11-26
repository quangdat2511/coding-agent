import type { AssistantMessage, UsageCost } from "@coding-agent/ai";
import type { JsonValue } from "./json.ts";
import type { VerificationSummary } from "./verification.ts";

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly cost?: UsageCost;
}

export type AgentFailureCode =
  | "MODEL_FAILURE"
  | "MODEL_PROTOCOL_ERROR"
  | "LIMIT_EXCEEDED"
  | "VERIFICATION_FAILED"
  | "CANCELLATION_TIMEOUT"
  | "INTERNAL_ERROR";

export type ModelFailurePhase = "request" | "stream" | "finish";

// The details of a MODEL_FAILURE (ADR 0002 §8): the phase and the normalized provider reason.
// httpStatus is the provider's HTTP status when one was recorded; which providers record it is
// stated on the error member of ModelStreamEvent in @coding-agent/ai.
export type ModelFailureDetails = {
  readonly phase: ModelFailurePhase;
  readonly reason: string;
  readonly rawReason?: string;
  readonly httpStatus?: number;
};

export type AgentFailure =
  | {
      readonly code: "MODEL_FAILURE";
      readonly message: string;
      readonly details: ModelFailureDetails;
    }
  | {
      readonly code: Exclude<AgentFailureCode, "MODEL_FAILURE">;
      readonly message: string;
      readonly details?: Readonly<Record<string, JsonValue>>;
    };

interface AgentResultBase {
  readonly finalMessage?: AssistantMessage;
  readonly usage: UsageTotals;
  readonly verification?: VerificationSummary;
  readonly workspaceChanged: boolean;
  readonly partialChangesPossible: boolean;
  readonly lastSequence: number;
}

export interface SucceededResult extends AgentResultBase {
  readonly outcome: "succeeded";
  readonly finalMessage: AssistantMessage;
  readonly verification: VerificationSummary;
}

export interface FailedResult extends AgentResultBase {
  readonly outcome: "failed";
  readonly failure: AgentFailure;
}

export interface CancelledResult extends AgentResultBase {
  readonly outcome: "cancelled";
  readonly cancellation: { readonly reason?: string };
}

export type AgentResult = SucceededResult | FailedResult | CancelledResult;
