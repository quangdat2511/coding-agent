import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import type {
  ExecutableTool,
  PathResolution,
  PrepareOutcome,
  RepoPath,
  ToolErrorCode,
  ToolOutcome,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import type { ChildProcess, ChildProcessLauncher } from "./child-process.ts";
import { displayPath, quote } from "./messages.ts";
import { createOutputCollector, type OutputCollector } from "./output-budget.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { findShell, processShellHost } from "./shell.ts";
import { prepareFailure, toolError } from "./tool-outcome.ts";

// ADR 0001 §3: a command gets 30 s unless the model asks for more, and never more than 120 s.
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MAX_BASH_TIMEOUT_MS = 120_000;

// After SIGTERM, a command gets this long to exit before its process group is killed. Windows has
// no such grace: taskkill /F ends the tree at once.
const KILL_GRACE_MS = 1_000;
// How long to keep reading after the shell exits. A background process that inherited the pipes
// keeps them open; past this limit its output is not waited for.
const DRAIN_MS = 200;
// The most recent output kept for Tool Progress. Agent Core bounds each update further.
const PROGRESS_WINDOW_CHARS = 8_192;

export const BashParams = Type.Object({
  command: Type.String({ minLength: 1, description: "The command to run with bash -c" }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_BASH_TIMEOUT_MS,
      description: `Timeout in milliseconds; default ${DEFAULT_BASH_TIMEOUT_MS}, at most ${MAX_BASH_TIMEOUT_MS}`,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Directory to start in, relative to the repository root or absolute inside it; " +
        "default is the repository root",
    }),
  ),
});

type BashInput = Static<typeof BashParams>;

export function bashTool(launcher: ChildProcessLauncher): ExecutableTool<typeof BashParams> {
  return {
    name: "bash",
    description:
      "Run a shell command in the repository with bash -c. The command runs non-interactively: " +
      "stdin is closed and CI=1, TERM=dumb are set, so a command that waits for input ends. " +
      `It times out after timeoutMs (default ${DEFAULT_BASH_TIMEOUT_MS}, at most ${MAX_BASH_TIMEOUT_MS}). ` +
      "stdout and stderr are returned together, bounded to 40 KiB with the start and the end kept, " +
      "followed by a status line such as [exit code: 0]. A command that fails can leave partial " +
      "changes behind. A background process keeps running after the command ends, but output it " +
      "prints after that is not returned; redirect it to a file to keep it.",
    parameters: BashParams,
    mutation: "mutating",

    // Resolves the start directory without running anything, so the Approval that follows shows
    // the whole command and where it will run.
    async prepare(input, { workspace }): Promise<PrepareOutcome<typeof BashParams>> {
      const invalid = checkInput(input);
      if (invalid !== undefined) {
        return prepareFailure<typeof BashParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
      const cwd = await resolveDirectory(workspace, input.cwd ?? workspace.repoRoot);
      if (!cwd.ok) {
        return prepareFailure<typeof BashParams>({ code: cwd.code, message: cwd.message });
      }
      return {
        ok: true,
        prepared: { input, paths: [cwd.path], summary: summarize(workspace, input, cwd.path) },
      };
    },

    // Re-validates the start directory, since the filesystem may have changed since prepare.
    async execute(prepared, { workspace, signal, onProgress }): Promise<ToolOutcome> {
      const cwd = await revalidatePreparedPath(prepared.paths, (path) =>
        resolveDirectory(workspace, path),
      );
      if (!cwd.ok) return toolError({ code: cwd.code, message: cwd.message });
      const shell = findShell(processShellHost());
      if (!shell.ok) return toolError({ code: "TOOL_INTERNAL_ERROR", message: shell.message });
      if (signal.aborted) return outcomeOf(createOutputCollector(), CANCELLED);

      const timeoutMs = prepared.input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
      return runCommand(launcher, {
        shell: shell.shell,
        command: prepared.input.command,
        cwd: cwd.path,
        timeoutMs,
        signal,
        onProgress: (output) => onProgress({ output }),
      });
    },
  };
}

// Schema Validation belongs to Agent Core (ADR 0001 §1); this repeats the schema's rules so a
// caller that skips it cannot start a command the declaration forbids, as read, write and edit do.
// A test checks that it refuses exactly the inputs BashParams refuses.
function checkInput({ command, timeoutMs, cwd }: BashInput): string | undefined {
  if (typeof command !== "string" || command.length === 0) return "command must be non-empty text";
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BASH_TIMEOUT_MS)
  ) {
    return `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_BASH_TIMEOUT_MS}`;
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    return "cwd must be a non-empty path";
  }
  return undefined;
}

// ADR 0001 §1 reports every unusable start directory as PATH_OUTSIDE_REPO: outside the
// repository, through a symbolic link, missing, or not a directory. The message says which.
async function resolveDirectory(
  workspace: WorkspaceResolver,
  input: string,
): Promise<PathResolution> {
  const resolved = await workspace.resolveExisting(input);
  const invalid = (reason: string): PathResolution => ({
    ok: false,
    code: "PATH_OUTSIDE_REPO",
    message: `cwd ${quote(input)} ${reason}`,
  });
  if (!resolved.ok) {
    if (resolved.code === "PATH_OUTSIDE_REPO") return resolved;
    return invalid(resolved.code === "NOT_FOUND" ? "does not exist" : "cannot be opened");
  }
  try {
    if (!(await stat(resolved.path)).isDirectory()) return invalid("is not a directory");
  } catch {
    return invalid("cannot be opened");
  }
  return { ok: true, path: resolved.path };
}

// The Approval summary shows the whole command: whoever approves it must see everything that will
// run. quote keeps a multi-line command on one line.
function summarize(workspace: WorkspaceResolver, input: BashInput, cwd: RepoPath): string {
  const where =
    cwd === workspace.repoRoot ? "" : ` in ${quote(displayPath(workspace.repoRoot, cwd))}`;
  const timeout =
    input.timeoutMs === undefined || input.timeoutMs === DEFAULT_BASH_TIMEOUT_MS
      ? ""
      : `; timeout ${input.timeoutMs} ms`;
  return `run ${quote(input.command)}${where}${timeout}`;
}

// Why bash itself stopped the command, when it did.
type StopReason = "timeout" | "cancelled";

// What the status line (ADR 0001 §7) reports: the error code of a failure, and how the command
// ended.
interface Status {
  readonly code?: ToolErrorCode;
  readonly text: string;
}

const CANCELLED: Status = { code: "SIGNAL", text: "cancelled" };

interface CommandRun {
  readonly shell: string;
  readonly command: string;
  readonly cwd: RepoPath;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  onProgress(output: string): void;
}

// The process supervision here (timeout, cancellation, descendant cleanup, draining) moves into a
// module shared with the Verification Runner in CDA-74 (ADR 0004 §4), rather than being copied.
async function runCommand(launcher: ChildProcessLauncher, run: CommandRun): Promise<ToolOutcome> {
  const posix = process.platform !== "win32";
  // `exec 2>&1` sends the command's stderr into its stdout pipe, so the two keep the order they
  // were written in. Joining two pipes by arrival does not: stderr is unbuffered and arrives in
  // bursts. The newline keeps a heredoc or a trailing comment in the command intact.
  const child = launcher.launch([run.shell, "-c", `exec 2>&1\n${run.command}`], {
    cwd: run.cwd,
    // On POSIX the command gets its own process group, so a timeout stops what it started too.
    // On Windows, taskkill /T stops the tree instead, and a detached child would open consoles.
    detached: posix,
  });

  const collector = createOutputCollector();
  let recent = "";
  const take = (chunk: Uint8Array, text: string) => {
    collector.push(chunk);
    recent = (recent + text).slice(-PROGRESS_WINDOW_CHARS);
    try {
      run.onProgress(recent);
    } catch {
      // Progress is advisory: an observer that fails must not stop the output being collected.
    }
  };
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const reading = Promise.all(readers.map((reader) => readAll(reader, take)));

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

  return outcomeOf(collector, statusOf(stopReason, child, run.timeoutMs));
}

// bash's own timer and abort decide TIMEOUT and cancellation, since a command can send itself the
// signal bash would. Otherwise a shell ended by a signal is SIGNAL, and an exit code other than 0
// is NON_ZERO_EXIT.
function statusOf(
  stopReason: StopReason | undefined,
  child: ChildProcess,
  timeoutMs: number,
): Status {
  if (stopReason === "timeout") {
    return { code: "TIMEOUT", text: `timed out after ${timeoutMs} ms` };
  }
  if (stopReason === "cancelled") return CANCELLED;
  if (child.signalCode) return { code: "SIGNAL", text: `terminated by ${child.signalCode}` };
  const exitCode = child.exitCode ?? 0;
  return exitCode === 0
    ? { text: "exit code: 0" }
    : { code: "NON_ZERO_EXIT", text: `exit code: ${exitCode}` };
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

// The status line ends the content so the model always sees how the command ended: Agent Core
// sends it only content and isError. Its bytes are reserved from the shared budget, so the whole
// content stays within 40 KiB.
function outcomeOf(collector: OutputCollector, { code, text }: Status): ToolOutcome {
  const statusLine = code === undefined ? `[${text}]` : `[${text}; partial changes may remain]`;
  // Asked before finish, because the separator's byte is part of what finish must leave free.
  const separator = collector.endsWithNewline() ? "" : "\n";
  const reserved = Buffer.byteLength(separator + statusLine, "utf8");
  const bounded = collector.finish(reserved);
  const output = bounded.content === "" ? "(no output)" : bounded.content;
  const content = `${output}${separator}${statusLine}`;
  const truncated = bounded.truncated ? { truncated: true } : {};
  return code === undefined
    ? { isError: false, content, ...truncated }
    : { isError: true, content, error: { code, message: content }, ...truncated };
}
