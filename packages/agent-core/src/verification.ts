import type { AssistantMessage, Message, UserMessage } from "@coding-agent/ai";

export type VerificationEvidence =
  | {
      readonly type: "command_execution";
      readonly command: string;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "command_system_failure";
      readonly command: string;
      readonly failureKind: "timed_out" | "launch_failed";
      readonly message: string;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "no_command_configured";
      readonly workspaceChanged: boolean;
    };

export type VerificationFeedback = UserMessage;

export interface VerificationProgress {
  readonly message: string;
}

export type VerificationOutcome = "succeeded" | "continue" | "failed" | "cancelled";

export interface VerificationSummary {
  readonly outcome: VerificationOutcome;
  readonly evidence: readonly VerificationEvidence[];
}

export interface VerificationCandidate {
  readonly transcript: readonly Message[];
  readonly finalMessage: AssistantMessage;
  readonly workspaceChanged: boolean;
}

export interface VerificationContext {
  readonly signal: AbortSignal;
  onProgress(update: VerificationProgress): void;
}

export type VerificationDecision =
  | { readonly outcome: "succeeded"; readonly evidence: readonly VerificationEvidence[] }
  | {
      readonly outcome: "continue";
      readonly evidence: readonly VerificationEvidence[];
      readonly feedback: VerificationFeedback;
    }
  | {
      readonly outcome: "failed";
      readonly evidence: readonly VerificationEvidence[];
      readonly message: string;
    };

// A Verification run the abort signal ended is not a decision (ADR 0003 §3): the policy reports it
// as cancelled. Agent Core aborts that signal only after a cancel it accepted, when it records the
// Verification run as cancelled, or after a breached limit, when the Agent Run settles
// LIMIT_EXCEEDED. A policy that reports cancelled at any other time fails the Agent Run with
// INTERNAL_ERROR. A policy that gives up on its own, as on a timeout of its own, decides failed
// instead.
export interface VerificationCancelled {
  readonly outcome: "cancelled";
}

export interface VerificationPolicy {
  verify(
    candidate: VerificationCandidate,
    ctx: VerificationContext,
  ): Promise<VerificationDecision | VerificationCancelled>;
}
