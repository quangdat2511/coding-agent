import type { RepoPath } from "@coding-agent/agent-core";
import type { ChildProcess, ChildProcessLauncher } from "./child-process.ts";

// Process supervision shared by bash and the Verification Runner (ADR 0004 §4): a timeout, the
// abort signal, ending what the command started, and reading what is left once it exits. Each
// caller decides what the exit means and how its output is reported.

// After SIGTERM, a command gets this long to exit before its process group is killed. Windows has
// no such grace: taskkill /F ends the tree at once.
const KILL_GRACE_MS = 1_000;
// How long to keep reading after the shell exits. A background process that inherited the pipes
// keeps them open; past this limit its output is not waited for.
const DRAIN_MS = 200;

// ADR 0001 §3: a command gets 30 s unless it asks for more, and never more than 120 s. bash and
// the Verification Runner share these bounds.
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;

/** Why timeoutMs is not a whole number of milliseconds within the bounds, or undefined if it is. */
export function timeoutProblem(timeoutMs: number): string | undefined {
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS
    ? undefined
    : `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`;
}

// Why the supervisor itself stopped the command, when it did.
export type StopReason = "timeout" | "cancelled";

export type ProcessKillFn = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => void;

export interface SupervisedRun {
  readonly argv: readonly string[];
  readonly cwd?: RepoPath;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Each chunk of output as it arrives, with its text decoded by that pipe's own decoder. */
  onOutput(chunk: Uint8Array, text: string): void;
  /** Optional separate handler for stderr; defaults to onOutput when omitted. */
  onStderr?: (chunk: Uint8Array, text: string) => void;
  /**
   * When true, wait for the whole process tree to exit after a timeout or cancellation before
   * returning, so callers cleaning up temporary directories cannot race with lingering children.
   */
  readonly waitForTreeExit?: boolean;
  /** Injectable process-group signaler (defaults to process.kill) so tests never signal real PIDs. */
  readonly killProcess?: ProcessKillFn;
}

export interface SupervisedExit {
  readonly stopReason?: StopReason;
  readonly exitCode: number | null;
  /** The signal the shell died of; set whether or not the supervisor sent it. */
  readonly signalCode: NodeJS.Signals | null;
}

// `exec 2>&1` sends the command's stderr into its stdout pipe, so the two keep the order they
// were written in. Joining two pipes by arrival does not: stderr is unbuffered and arrives in
// bursts. The newline keeps a heredoc or a trailing comment in the command intact.
export function combinedOutputArgv(shell: string, command: string): string[] {
  return [shell, "-c", `exec 2>&1\n${command}`];
}

export async function runSupervised(
  launcher: ChildProcessLauncher,
  run: SupervisedRun,
): Promise<SupervisedExit> {
  const posix = process.platform !== "win32";
  const child = launcher.launch(run.argv, {
    cwd: run.cwd,
    // On POSIX the command gets its own process group, so a timeout stops what it started too.
    // On Windows, taskkill /T stops the tree instead, and a detached child would open consoles.
    detached: posix,
  });

  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const readers = [stdoutReader, stderrReader];
  const reading = Promise.all([
    readAll(stdoutReader, run.onOutput),
    readAll(stderrReader, run.onStderr ?? run.onOutput),
  ]);

  const killProcess: ProcessKillFn = run.killProcess ?? ((pid, sig) => process.kill(pid, sig));
  let stopReason: StopReason | undefined;
  let terminatedAt = 0;
  let sigkillSent = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingTreeSignal: Promise<void> | undefined;
  const terminate = (reason: StopReason) => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    terminatedAt = Date.now();
    pendingTreeSignal = signalTree(launcher, child, "SIGTERM", killProcess);
    // Always schedule SIGKILL even when waitForTreeExit is true: if the main child ignores
    // SIGTERM, `await child.exited` below would otherwise wait forever.
    killTimer = setTimeout(() => {
      if (groupAlive(child, killProcess)) {
        sigkillSent = true;
        pendingTreeSignal = signalTree(launcher, child, "SIGKILL", killProcess);
      }
    }, KILL_GRACE_MS);
  };
  const timeoutTimer = setTimeout(() => terminate("timeout"), run.timeoutMs);
  const onAbort = () => terminate("cancelled");
  run.signal.addEventListener("abort", onAbort, { once: true });
  // A listener added to a signal that has already aborted never runs, so a caller that awaited
  // something between its own check and this call would otherwise start a command nobody stops.
  if (run.signal.aborted) terminate("cancelled");

  try {
    await child.exited;
  } finally {
    // How the command ended is settled once the shell exits: a cancellation that arrives while
    // the remaining output is read must not turn a finished command into a cancelled one, nor
    // stop the background processes it left running.
    clearTimeout(timeoutTimer);
    run.signal.removeEventListener("abort", onAbort);
  }
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    reading,
    new Promise((resolve) => {
      drainTimer = setTimeout(resolve, DRAIN_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  for (const reader of readers) reader.cancel().catch(() => undefined);

  if (run.waitForTreeExit && stopReason !== undefined) {
    clearTimeout(killTimer);
    await waitForProcessTreeExit(
      launcher,
      child,
      killProcess,
      terminatedAt,
      sigkillSent,
      pendingTreeSignal,
    );
  } else if (!groupAlive(child, killProcess)) {
    // A group that has already exited needs no SIGKILL; skipping it also avoids signalling a group
    // that later reuses the id.
    clearTimeout(killTimer);
  }

  return {
    ...(stopReason === undefined ? {} : { stopReason }),
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
}

const TREE_POLL_MS = 25;
const SIGKILL_WAIT_MS = 500;

async function waitForProcessTreeExit(
  launcher: ChildProcessLauncher,
  child: ChildProcess,
  killProcess: ProcessKillFn,
  terminatedAt: number,
  sigkillSent: boolean,
  pendingTreeSignal: Promise<void> | undefined,
): Promise<void> {
  if (pendingTreeSignal !== undefined) {
    await pendingTreeSignal;
  }
  if (process.platform === "win32") return;

  if (!sigkillSent) {
    const graceDeadline = terminatedAt + KILL_GRACE_MS;
    while (groupAlive(child, killProcess) && Date.now() < graceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, TREE_POLL_MS));
    }
    if (!groupAlive(child, killProcess)) return;

    await signalTree(launcher, child, "SIGKILL", killProcess);
  }

  const killDeadline = Date.now() + SIGKILL_WAIT_MS;
  while (groupAlive(child, killProcess) && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, TREE_POLL_MS));
  }
}

// Reads one pipe until it closes or is cancelled, decoding with its own stream decoder so a
// character split across chunks of one pipe is not mixed with the other's bytes.
async function readAll(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  take: (chunk: Uint8Array, text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for (;;) {
    let next: { done: boolean; value?: Uint8Array };
    try {
      next = await reader.read();
    } catch {
      return; // Cancelled after the drain limit.
    }
    if (next.done || next.value === undefined) return;
    if (next.value.byteLength > 0) take(next.value, decoder.decode(next.value, { stream: true }));
  }
}

// Whether any process is left in the command's group. Windows has no process groups, and
// taskkill /T already ended the tree, so there is nothing left to kill.
function groupAlive(child: ChildProcess, killProcess: ProcessKillFn): boolean {
  if (process.platform === "win32") return false;
  try {
    killProcess(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// POSIX signals the whole process group the command leads. Windows has no signals, so both steps
// end the process tree with taskkill, started through the same launcher as every other child.
async function signalTree(
  launcher: ChildProcessLauncher,
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  killProcess: ProcessKillFn,
): Promise<void> {
  if (process.platform === "win32") {
    let taskkillSucceeded = false;
    try {
      const killer = launcher.launch(["taskkill", "/T", "/F", "/PID", String(child.pid)]);
      const code = await killer.exited;
      taskkillSucceeded = code === 0;
    } catch {
      // taskkill failed to launch or wait; fall back to ending the direct child handle below.
    }
    if (!taskkillSucceeded) {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }
    return;
  }
  try {
    killProcess(-child.pid, signal);
  } catch {
    // Either the group has already exited or the child is not a process group leader (e.g. a
    // non-detached or fake child in tests); fall back to signalling the child handle directly.
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}
