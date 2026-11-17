import { Buffer } from "node:buffer";
import type {
  VerificationCancelled,
  VerificationDecision,
  VerificationPolicy,
} from "@coding-agent/agent-core";
import { quote } from "./messages.ts";
import { boundToolOutput, MAX_TOOL_OUTPUT_BYTES } from "./output-budget.ts";
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
function bounded(output: string, budget = MAX_TOOL_OUTPUT_BYTES): string {
  return boundToolOutput(output, budget).content;
}

// The budget covers stdout and stderr together (ADR 0003 §3). Evidence keeps the two streams apart,
// so they share the budget: each gets half, and a stream that needs less gives the rest to the
// other. A stream that is cut keeps at least half, enough for the marker and both ends; bounding
// one stream first and giving the other what remains could leave it nothing. The runner leaves
// stderr empty, which gives stdout all of it.
function boundedStreams(
  stdout: string,
  stderr: string,
): { readonly stdout: string; readonly stderr: string } {
  const outBytes = byteLength(stdout);
  const errBytes = byteLength(stderr);
  if (outBytes + errBytes <= MAX_TOOL_OUTPUT_BYTES) return { stdout, stderr };
  const half = Math.floor(MAX_TOOL_OUTPUT_BYTES / 2);
  const errBudget = Math.min(errBytes, Math.max(half, MAX_TOOL_OUTPUT_BYTES - outBytes));
  return {
    stdout: bounded(stdout, MAX_TOOL_OUTPUT_BYTES - errBudget),
    stderr: bounded(stderr, errBudget),
  };
}

// Buffer.from gives the real byte count where Bun's Buffer.byteLength miscounts (output-budget.ts).
function byteLength(text: string): number {
  return Buffer.from(text, "utf8").byteLength;
}

function decide(
  command: string,
  result: VerificationRunnerResult,
): VerificationDecision | VerificationCancelled {
  switch (result.status) {
    case "completed": {
      const { exitCode, durationMs } = result;
      const { stdout, stderr } = boundedStreams(result.stdout, result.stderr);
      const evidence = [
        { type: "command_execution", command, exitCode, stdout, stderr, durationMs } as const,
      ];
      if (exitCode === 0) return { outcome: "succeeded", evidence };
      // The feedback has one Output section, so it bounds the two streams joined.
      const output = bounded(result.stdout + result.stderr);
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
            ...boundedStreams(result.stdout, result.stderr),
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

// ADR 0003 §3's template. Output that does not end with a newline gets one, so the closing line
// always starts a line of its own, and empty output reads "(no output)", both as bash writes its
// status line.
function failureFeedback(command: string, exitCode: number, output: string): string {
  const shown = output === "" ? "(no output)" : output;
  const separator = shown.endsWith("\n") ? "" : "\n";
  return (
    "[Verification Failed]\n" +
    `Command: ${command}\n` +
    `Exit code: ${exitCode}\n` +
    "Output:\n" +
    `${shown}${separator}` +
    "Please analyze the failure, adjust your changes, and verify again."
  );
}
