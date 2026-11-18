import type {
  VerificationCancelled,
  VerificationDecision,
  VerificationPolicy,
} from "@coding-agent/agent-core";
import { quote } from "./messages.ts";
import { boundToolOutput } from "./output-budget.ts";
import type { VerificationRunner, VerificationRunnerResult } from "./verification-runner.ts";

export interface VerificationPolicyOptions {
  /** The configured verification command, or null when none is configured. */
  readonly command: string | null;
  readonly runner: VerificationRunner;
}

export function createVerificationPolicy({
  command,
  runner,
}: VerificationPolicyOptions): VerificationPolicy {
  return {
    async verify({ workspaceChanged }, { signal }) {
      if (command === null) {
        return {
          outcome: "succeeded",
          evidence: [{ type: "no_command_configured", workspaceChanged }],
        };
      }
      return decide(command, await runner.run(command, { signal }));
    },
  };
}

// ADR 0003 §3 bounds output with ADR 0001's 40 KiB head+tail rule before it is recorded or sent.
// The runner already captures within that budget, so this only cuts a result from a runner that
// does not.
function bounded(output: string): string {
  return boundToolOutput(output).content;
}

// The one output a run printed, within the budget. The runner writes it all to stdout after
// `exec 2>&1` and leaves stderr empty (ADR 0003 §5, CDA-74), and the budget applies to that
// combined output. A runner that fills stderr gets it after stdout, on a line of its own, rather
// than a budget split between the streams, which no ADR defines.
function combinedOutput(stdout: string, stderr: string): string {
  if (stdout === "" || stderr === "" || stdout.endsWith("\n")) return bounded(stdout + stderr);
  return bounded(`${stdout}\n${stderr}`);
}

function decide(
  command: string,
  result: VerificationRunnerResult,
): VerificationDecision | VerificationCancelled {
  switch (result.status) {
    case "completed": {
      const { exitCode, durationMs } = result;
      const output = combinedOutput(result.stdout, result.stderr);
      const evidence = [
        {
          type: "command_execution",
          command,
          exitCode,
          stdout: output,
          stderr: "",
          durationMs,
        } as const,
      ];
      if (exitCode === 0) return { outcome: "succeeded", evidence };
      return {
        outcome: "continue",
        evidence,
        feedback: { role: "user", content: failureFeedback(command, exitCode, output) },
      };
    }
    case "timed_out": {
      const { timeoutMs, durationMs } = result;
      const message = `timed out after ${timeoutMs} ms`;
      return {
        outcome: "failed",
        evidence: [
          {
            type: "command_system_failure",
            command,
            failureKind: "timed_out",
            message,
            stdout: combinedOutput(result.stdout, result.stderr),
            stderr: "",
            durationMs,
          },
        ],
        message: `the verification command ${quote(command)} ${message}`,
      };
    }
    case "launch_failed": {
      const { exitCode, durationMs } = result;
      const error = bounded(result.error);
      return {
        outcome: "failed",
        evidence: [
          {
            type: "command_system_failure",
            command,
            failureKind: "launch_failed",
            message: error,
            ...(exitCode === undefined ? {} : { exitCode }),
            durationMs,
          },
        ],
        message: `the verification command ${quote(command)} could not run: ${error}`,
      };
    }
    // ADR 0003 §3: a cancelled run is not a decision. Agent Core records the Verification as
    // cancelled, and whatever the run printed is not evidence of anything.
    case "cancelled":
      return { outcome: "cancelled" };
  }
}

// ADR 0003 §3's template. The command is quoted, as every tool result quotes text that can hold a
// newline, so a command that spans lines cannot pass for output. Output that does not end with a
// newline gets one, so the closing line always starts a line of its own, and empty output reads
// "(no output)", both as bash writes its status line. The budget bounds the output only: the
// header, this newline and the closing line are outside it.
function failureFeedback(command: string, exitCode: number, output: string): string {
  const shown = output === "" ? "(no output)" : output;
  const separator = shown.endsWith("\n") ? "" : "\n";
  return (
    "[Verification Failed]\n" +
    `Command: ${quote(command)}\n` +
    `Exit code: ${exitCode}\n` +
    "Output:\n" +
    `${shown}${separator}` +
    "Please analyze the failure, adjust your changes, and verify again."
  );
}
