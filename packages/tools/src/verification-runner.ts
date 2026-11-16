import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import { constants } from "node:os";
import type { WorkspaceResolver } from "@coding-agent/agent-core";
import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS } from "./bash.ts";
import type { ChildProcessLauncher } from "./child-process.ts";
import { quote } from "./messages.ts";
import { createOutputCollector, type OutputCollector } from "./output-budget.ts";
import {
  combinedOutputArgv,
  runSupervised,
  type SupervisedExit,
  type SupervisedRun,
} from "./process-run.ts";
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
        const launchFailed = (error: string, exitCode?: number): VerificationRunnerResult => ({
          status: "launch_failed",
          error,
          ...(exitCode === undefined ? {} : { exitCode }),
          durationMs: elapsed(),
        });
        // A signal can abort while the run awaits, as it does while the root is checked, and a
        // listener the supervisor adds after that would never run. So the signal is asked again
        // right before each launch, as bash asks it right before its own.
        const cancelledBeforeStart = (): VerificationRunnerResult => ({
          status: "cancelled",
          ...noOutput,
          durationMs: elapsed(),
        });
        if (signal.aborted) return cancelledBeforeStart();
        const shell = findShell(host);
        if (!shell.ok) return launchFailed(shell.message);
        const unusableRoot = await checkRepoRoot(workspace);
        if (unusableRoot !== undefined) return launchFailed(unusableRoot);
        if (signal.aborted) return cancelledBeforeStart();

        const run = (argv: readonly string[], limitMs: number) =>
          supervise(launcher, { argv, cwd: workspace.repoRoot, timeoutMs: limitMs, signal });
        const stopped = (exit: SupervisedExit, collector: OutputCollector) => {
          const output = { stdout: collector.finish(0).content, stderr: "" };
          if (exit.stopReason === "timeout") {
            return { status: "timed_out", timeoutMs, ...output, durationMs: elapsed() } as const;
          }
          if (exit.stopReason === "cancelled") {
            return { status: "cancelled", ...output, durationMs: elapsed() } as const;
          }
          return undefined;
        };

        // bash -n parses the command without running any of it. A syntax error cannot be told
        // from the command's own exit code, because a failing make or test runner also exits 2,
        // and without this check bash would run the lines before the error.
        const check = await run([shell.shell, "-n", "-c", command], timeoutMs);
        if (!check.ok) return launchFailed(couldNotStart(shell.shell, check.error));
        const checkStopped = stopped(check.exit, check.collector);
        if (checkStopped !== undefined) return checkStopped;
        const checkCode = exitCodeOf(check.exit);
        if (checkCode !== 0) {
          return launchFailed(withOutput("shell syntax error:\n", check.collector), checkCode);
        }

        // The check and the command share one deadline, so the whole run stays within the same
        // bound as a bash Tool Call.
        const remainingMs = Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
        // The check's output is still read after its shell exits, and an abort then reaches no
        // listener.
        if (signal.aborted) return cancelledBeforeStart();
        const main = await run(combinedOutputArgv(shell.shell, command), remainingMs);
        if (!main.ok) return launchFailed(couldNotStart(shell.shell, main.error));
        const mainStopped = stopped(main.exit, main.collector);
        if (mainStopped !== undefined) return mainStopped;
        const exitCode = exitCodeOf(main.exit);
        // ADR 0003 §3: the shell reports 127 for a command it cannot find and 126 for one it
        // cannot execute, so the command never ran to a test result.
        if (exitCode === 126 || exitCode === 127) {
          const reason = `exit code ${exitCode} (command not found or not executable):\n`;
          return launchFailed(withOutput(reason, main.collector), exitCode);
        }
        return {
          status: "completed",
          exitCode,
          stdout: main.collector.finish(0).content,
          stderr: "",
          durationMs: elapsed(),
        };
      },
    },
  };
}

type Supervised =
  | { readonly ok: true; readonly exit: SupervisedExit; readonly collector: OutputCollector }
  | { readonly ok: false; readonly error: unknown };

// Starting the shell can throw at once, as Bun.spawn does for a shell or directory that has gone
// since the checks; the runner reports that rather than rejecting.
async function supervise(
  launcher: ChildProcessLauncher,
  run: Omit<SupervisedRun, "onOutput">,
): Promise<Supervised> {
  const collector = createOutputCollector();
  try {
    const exit = await runSupervised(launcher, {
      ...run,
      onOutput: (chunk) => collector.push(chunk),
    });
    return { ok: true, exit, collector };
  } catch (error) {
    return { ok: false, error };
  }
}

function couldNotStart(shell: string, error: unknown): string {
  return `could not start ${quote(shell)}: ${error instanceof Error ? error.message : String(error)}`;
}

// The reason comes first and the output follows, the whole error within the shared 40 KiB budget.
function withOutput(reason: string, collector: OutputCollector): string {
  return reason + collector.finish(Buffer.byteLength(reason, "utf8")).content;
}

// Like bash re-validating its start directory in execute: the repository root was checked when
// the workspace was created, and the filesystem may have changed since. A root that now resolves
// elsewhere, as when it was replaced by a symbolic link, is refused, so the command cannot run
// outside the repository.
async function checkRepoRoot(workspace: WorkspaceResolver): Promise<string | undefined> {
  const root = workspace.repoRoot;
  const unusable = (reason: string) => `repository root ${quote(root)} cannot be used: ${reason}`;
  const resolved = await workspace.resolveExisting(root);
  if (!resolved.ok) return unusable(resolved.message);
  if (resolved.path !== root) return unusable(`it now resolves to ${quote(resolved.path)}`);
  try {
    if (!(await stat(root)).isDirectory()) return unusable("it is not a directory");
  } catch {
    return unusable("it cannot be opened");
  }
  return undefined;
}

const noOutput = { stdout: "", stderr: "" } as const;

// A shell ended by a signal the runner did not send, such as an out-of-memory kill or a crash,
// reports 128 plus the signal's number, as a shell reports a child that died that way. The test
// that crashed is a failure the model may fix, not an environment that cannot run.
function exitCodeOf({ exitCode, signalCode }: SupervisedExit): number {
  if (signalCode) return 128 + (constants.signals[signalCode] ?? 0);
  return exitCode ?? 0;
}
