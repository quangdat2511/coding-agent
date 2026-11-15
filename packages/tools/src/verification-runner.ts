import { constants } from "node:os";
import type { WorkspaceResolver } from "@coding-agent/agent-core";
import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS } from "./bash.ts";
import type { ChildProcessLauncher } from "./child-process.ts";
import { quote } from "./messages.ts";
import { createOutputCollector } from "./output-budget.ts";
import { combinedOutputArgv, runSupervised, type SupervisedExit } from "./process-run.ts";
import { findShell, processShellHost, type ShellHost } from "./shell.ts";

// What running the configured verification command produced (ADR 0003 §3), so the Verification
// Policy above it never has to guess why a command produced nothing. The command runs after
// `exec 2>&1`, as bash does, so all of its output is in stdout, in the order it was written, and
// stderr is always empty. `cancelled` is not in ADR 0003's union: an aborted run is neither a
// finished command nor one that could not start.
export type VerificationRunnerResult =
  | {
      readonly status: "completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "timed_out";
      readonly timeoutMs: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "launch_failed";
      readonly error: string;
      readonly exitCode?: number;
      readonly durationMs: number;
    }
  | {
      readonly status: "cancelled";
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    };

export interface VerificationRunnerOptions {
  readonly launcher: ChildProcessLauncher;
  readonly workspace: WorkspaceResolver;
  /** The same bounds as bash (ADR 0001 §3): 30,000 ms by default, at most 120,000 ms. */
  readonly timeoutMs?: number;
}

export interface VerificationRunner {
  /** Runs the command in the repository root. It never rejects. */
  run(
    command: string,
    options: { readonly signal: AbortSignal },
  ): Promise<VerificationRunnerResult>;
}

export type CreateVerificationRunnerResult =
  | { readonly ok: true; readonly runner: VerificationRunner }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly message: string;
      readonly field: "timeoutMs";
    };

export function createVerificationRunner(
  options: VerificationRunnerOptions,
): CreateVerificationRunnerResult {
  return createVerificationRunnerOn(processShellHost(), options);
}

// The shell host is a test seam, as for findShell: tests pass a host with no shell.
export function createVerificationRunnerOn(
  host: ShellHost,
  { launcher, workspace, timeoutMs = DEFAULT_BASH_TIMEOUT_MS }: VerificationRunnerOptions,
): CreateVerificationRunnerResult {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BASH_TIMEOUT_MS) {
    return {
      ok: false,
      code: "INVALID_CONFIGURATION",
      message:
        `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_BASH_TIMEOUT_MS}, ` +
        `got ${quote(String(timeoutMs))}`,
      field: "timeoutMs",
    };
  }

  return {
    ok: true,
    runner: {
      async run(command, { signal }) {
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        if (signal.aborted) return { status: "cancelled", ...noOutput, durationMs: elapsed() };
        const shell = findShell(host);
        if (!shell.ok)
          return { status: "launch_failed", error: shell.message, durationMs: elapsed() };

        const collector = createOutputCollector();
        const exit = await runSupervised(launcher, {
          argv: combinedOutputArgv(shell.shell, command),
          cwd: workspace.repoRoot,
          timeoutMs,
          signal,
          onOutput: (chunk) => collector.push(chunk),
        });
        const output = { stdout: collector.finish(0).content, stderr: "" };
        const durationMs = elapsed();
        if (exit.stopReason === "timeout") {
          return { status: "timed_out", timeoutMs, ...output, durationMs };
        }
        if (exit.stopReason === "cancelled") return { status: "cancelled", ...output, durationMs };
        return { status: "completed", exitCode: exitCodeOf(exit), ...output, durationMs };
      },
    },
  };
}

const noOutput = { stdout: "", stderr: "" } as const;

// A shell ended by a signal the runner did not send, such as an out-of-memory kill or a crash,
// reports 128 plus the signal's number, as a shell reports a child that died that way. The test
// that crashed is a failure the model may fix, not an environment that cannot run.
function exitCodeOf({ exitCode, signalCode }: SupervisedExit): number {
  if (signalCode) return 128 + (constants.signals[signalCode] ?? 0);
  return exitCode ?? 0;
}
