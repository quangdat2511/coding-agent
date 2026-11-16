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
import type { ChildProcessLauncher } from "./child-process.ts";
import { displayPath, quote } from "./messages.ts";
import { createOutputCollector, type OutputCollector } from "./output-budget.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import {
  combinedOutputArgv,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runSupervised,
  type SupervisedExit,
  timeoutProblem,
} from "./process-run.ts";
import { findShell, processShellHost } from "./shell.ts";
import { prepareFailure, toolError } from "./tool-outcome.ts";

// ADR 0001 §3's bounds, shared with the Verification Runner.
export const DEFAULT_BASH_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const MAX_BASH_TIMEOUT_MS = MAX_TIMEOUT_MS;

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
  const timeout = timeoutMs === undefined ? undefined : timeoutProblem(timeoutMs);
  if (timeout !== undefined) return timeout;
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

// Timeout, cancellation, descendant cleanup and draining are the shared supervisor's, which the
// Verification Runner uses too (ADR 0004 §4); what the exit means for a Tool Call is decided here.
async function runCommand(launcher: ChildProcessLauncher, run: CommandRun): Promise<ToolOutcome> {
  const collector = createOutputCollector();
  let recent = "";
  const exit = await runSupervised(launcher, {
    argv: combinedOutputArgv(run.shell, run.command),
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    signal: run.signal,
    onOutput: (chunk, text) => {
      collector.push(chunk);
      recent = (recent + text).slice(-PROGRESS_WINDOW_CHARS);
      try {
        run.onProgress(recent);
      } catch {
        // Progress is advisory: an observer that fails must not stop the output being collected.
      }
    },
  });
  return outcomeOf(collector, statusOf(exit, run.timeoutMs));
}

// The supervisor's own timer and abort decide TIMEOUT and cancellation, since a command can send
// itself the signal the supervisor would. Otherwise a shell ended by a signal is SIGNAL, and an
// exit code other than 0 is NON_ZERO_EXIT.
function statusOf({ stopReason, exitCode, signalCode }: SupervisedExit, timeoutMs: number): Status {
  if (stopReason === "timeout") {
    return { code: "TIMEOUT", text: `timed out after ${timeoutMs} ms` };
  }
  if (stopReason === "cancelled") return CANCELLED;
  if (signalCode) return { code: "SIGNAL", text: `terminated by ${signalCode}` };
  const code = exitCode ?? 0;
  return code === 0
    ? { text: "exit code: 0" }
    : { code: "NON_ZERO_EXIT", text: `exit code: ${code}` };
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
