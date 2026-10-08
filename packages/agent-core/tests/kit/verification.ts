import type {
  VerificationCandidate,
  VerificationDecision,
  VerificationPolicy,
} from "../../src/index.ts";

export interface FakeVerification extends VerificationPolicy {
  readonly candidates: readonly VerificationCandidate[];
}

export function fakeVerification(
  decisions: readonly VerificationDecision[] = [],
): FakeVerification {
  const remaining = [...decisions];
  const candidates: VerificationCandidate[] = [];

  return {
    candidates,
    async verify(candidate) {
      candidates.push(candidate);
      return (
        remaining.shift() ?? {
          outcome: "succeeded",
          evidence: [
            { type: "no_command_configured", workspaceChanged: candidate.workspaceChanged },
          ],
        }
      );
    },
  };
}
