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

export interface VerificationPolicy {
  verify(candidate: VerificationCandidate, ctx: VerificationContext): Promise<VerificationDecision>;
}
