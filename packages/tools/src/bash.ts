import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolErrorCode,
  ToolOutcome,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import type { ChildProcess, ChildProcessLauncher } from "./child-process.ts";
import { displayPath, quote } from "./messages.ts";
import { createOutputCollector } from "./output-budget.ts";
import { findShell, hostShell, type ShellHost } from "./shell.ts";
import { prepareFailure } from "./tool-outcome.ts";

// ADR 0001 §3: a command gets 30 s unless the model asks for more, and never more than 120 s.
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MAX_BASH_TIMEOUT_MS = 120_000;

// After SIGTERM, a command gets this long to exit before its process group is killed.
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

export interface BashToolOptions {
  readonly shellHost?: ShellHost;
}

export function bashTool(
  launcher: ChildProcessLauncher,
  { shellHost = hostShell }: BashToolOptions = {},
): ExecutableTool<typeof BashParams> {
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
      if (!cwd.ok) return prepareFailure<typeof BashParams>(cwd.error);
      return {
        ok: true,
        prepared: { input, paths: [cwd.path], summary: summarize(workspace, input, cwd.path) },
      };
    },

    // Re-validates the start directory, since the filesystem may have changed since prepare.
    async execute(prepared, { workspace, signal, onProgress }): Promise<ToolOutcome> {
      const [preparedCwd] = prepared.paths;
      const cwd = await resolveDirectory(workspace, preparedCwd ?? workspace.repoRoot);
      if (!cwd.ok) return failure(cwd.error.code, cwd.error.message);
      if (cwd.path !== preparedCwd) {
        return failure(
          "PATH_OUTSIDE_REPO",
          `${quote(String(preparedCwd))} changed after it was prepared`,
        );
      }
      const shell = findShell(shellHost);
      if (!shell.ok) return failure("TOOL_INTERNAL_ERROR", shell.message);
      if (signal.aborted) return finish(createOutputCollector(), { kind: "cancelled" });

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
// caller that skips it cannot start a command the declaration forbids.
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

type DirectoryResolution =
  | { readonly ok: true; readonly path: RepoPath }
  | { readonly ok: false; readonly error: { code: ToolErrorCode; message: string } };

// ADR 0001 §1 reports every unusable start directory as PATH_OUTSIDE_REPO: outside the
// repository, through a symbolic link, missing, or not a directory. The message says which.
async function resolveDirectory(
  workspace: WorkspaceResolver,
  input: string,
): Promise<DirectoryResolution> {
  const resolved = await workspace.resolveExisting(input);
  const invalid = (reason: string): DirectoryResolution => ({
    ok: false,
    error: { code: "PATH_OUTSIDE_REPO", message: `cwd ${quote(input)} ${reason}` },
  });
  if (!resolved.ok) {
    if (resolved.code === "PATH_OUTSIDE_REPO") return { ok: false, error: resolved };
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

type Ending =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "cancelled" };

interface CommandRun {
  readonly shell: string;
  readonly command: string;
  readonly cwd: RepoPath;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  onProgress(output: string): void;
}

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
  const decoder = new TextDecoder();
  let recent = "";
  let lastByte: number | undefined;
  const take = (chunk: Uint8Array) => {
    if (chunk.byteLength === 0) return;
    collector.push(chunk);
    lastByte = chunk[chunk.byteLength - 1];
    recent = (recent + decoder.decode(chunk, { stream: true })).slice(-PROGRESS_WINDOW_CHARS);
    run.onProgress(recent);
  };
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const reading = Promise.all(readers.map((reader) => drain(reader, take)));

  let stop: "timeout" | "cancelled" | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "timeout" | "cancelled") => {
    if (stop !== undefined) return;
    stop = reason;
    signalTree(launcher, child, "SIGTERM");
    killTimer = setTimeout(() => signalTree(launcher, child, "SIGKILL"), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => terminate("timeout"), run.timeoutMs);
  const onAbort = () => terminate("cancelled");
  run.signal.addEventListener("abort", onAbort, { once: true });

  try {
    await child.exited;
    clearTimeout(timer);
    let drained: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      reading,
      new Promise((resolve) => {
        drained = setTimeout(resolve, DRAIN_MS);
      }),
    ]);
    clearTimeout(drained);
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", onAbort);
    for (const reader of readers) reader.cancel().catch(() => undefined);
  }
  // A process group still alive after a timeout or cancellation gets SIGKILL on schedule; one
  // whose shell exited on its own is left running, as a background server should be.
  if (stop === undefined) clearTimeout(killTimer);

  const ending: Ending =
    stop === "timeout"
      ? { kind: "timeout", timeoutMs: run.timeoutMs }
      : stop === "cancelled"
        ? { kind: "cancelled" }
        : child.signalCode
          ? { kind: "signal", signal: child.signalCode }
          : { kind: "exit", code: child.exitCode ?? 0 };
  return finish(collector, ending, lastByte);
}

async function drain(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  take: (chunk: Uint8Array) => void,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) return;
      take(value);
    }
  } catch {
    // Cancelled after the drain limit.
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

const NEWLINE = 0x0a;

// The status line ends the content so the model always sees how the command ended: Agent Core
// sends it only content and isError. Its bytes are reserved from the shared budget, so the whole
// content stays within 40 KiB.
function finish(
  collector: ReturnType<typeof createOutputCollector>,
  ending: Ending,
  lastByte?: number,
): ToolOutcome {
  const { code, status } = describe(ending);
  const statusLine = code === undefined ? `[${status}]` : `[${status}; partial changes may remain]`;
  const empty = lastByte === undefined;
  const separator = !empty && lastByte === NEWLINE ? "" : "\n";
  const reserved = Buffer.byteLength(separator + statusLine, "utf8");
  const bounded = collector.finish(reserved);
  const content = `${empty ? "(no output)" : bounded.content}${separator}${statusLine}`;
  const truncated = bounded.truncated ? { truncated: true } : {};
  return code === undefined
    ? { isError: false, content, ...truncated }
    : { isError: true, content, error: { code, message: content }, ...truncated };
}

function describe(ending: Ending): { code?: ToolErrorCode; status: string } {
  switch (ending.kind) {
    case "exit":
      return ending.code === 0
        ? { status: "exit code: 0" }
        : { code: "NON_ZERO_EXIT", status: `exit code: ${ending.code}` };
    case "timeout":
      return { code: "TIMEOUT", status: `timed out after ${ending.timeoutMs} ms` };
    case "signal":
      return { code: "SIGNAL", status: `terminated by ${ending.signal}` };
    case "cancelled":
      return { code: "SIGNAL", status: "cancelled" };
  }
}

function failure(code: ToolErrorCode, message: string): ToolOutcome {
  return { isError: true, content: message, error: { code, message } };
}
