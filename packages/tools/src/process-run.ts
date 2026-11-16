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

// Why the supervisor itself stopped the command, when it did.
export type StopReason = "timeout" | "cancelled";

export interface SupervisedRun {
  readonly argv: readonly string[];
  readonly cwd: RepoPath;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Each chunk of output as it arrives, with its text decoded by that pipe's own decoder. */
  onOutput(chunk: Uint8Array, text: string): void;
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

  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const reading = Promise.all(readers.map((reader) => readAll(reader, run.onOutput)));

  let stopReason: StopReason | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: StopReason) => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    signalTree(launcher, child, "SIGTERM");
    killTimer = setTimeout(() => {
      if (groupAlive(child)) signalTree(launcher, child, "SIGKILL");
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
  // A group that has already exited needs no SIGKILL; skipping it also avoids signalling a group
  // that later reuses the id.
  if (!groupAlive(child)) clearTimeout(killTimer);

  return {
    ...(stopReason === undefined ? {} : { stopReason }),
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
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
function groupAlive(child: ChildProcess): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// POSIX signals the whole process group the command leads. Windows has no signals, so both steps
// end the process tree with taskkill, started through the same launcher as every other child.
function signalTree(
  launcher: ChildProcessLauncher,
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (process.platform === "win32") {
    try {
      launcher.launch(["taskkill", "/T", "/F", "/PID", String(child.pid)]);
    } catch {
      // The tree is already gone or taskkill is missing; the drain limit still ends the call.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}
