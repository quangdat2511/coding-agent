import type {
  VerificationCandidate,
  VerificationDecision,
  VerificationPolicy,
} from "../../src/index.ts";

export type ScriptedDecision =
  | VerificationDecision
  | ((candidate: VerificationCandidate) => Promise<VerificationDecision>);

export interface FakeVerification extends VerificationPolicy {
  readonly candidates: readonly VerificationCandidate[];
}

export function continueWith(feedback: string): VerificationDecision {
  return { outcome: "continue", evidence: [], feedback: { role: "user", content: feedback } };
}

export function fakeVerification(decisions: readonly ScriptedDecision[] = []): FakeVerification {
  const remaining = [...decisions];
  const candidates: VerificationCandidate[] = [];

  return {
    candidates,
    async verify(candidate) {
      candidates.push(candidate);
      const decision = remaining.shift() ?? {
        outcome: "succeeded",
        evidence: [{ type: "no_command_configured", workspaceChanged: candidate.workspaceChanged }],
      };
      return typeof decision === "function" ? decision(candidate) : decision;
    },
  };
}
