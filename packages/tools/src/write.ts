import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolErrorCode,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import { errnoOf } from "./errno.ts";

// A write target must name a file: it cannot end with "/" or "\", and its final component cannot
// be "." or "..". Both separators are covered so a Windows model path follows the same rule. The
// negative lookaheads keep it expressible in the JSON Schema handed to the model as well as in
// checkInput.
const FILE_PATH = /^(?!.*[\\/]\.?$)(?!\.{1,2}$)(?!.*[\\/]\.{1,2}$).+$/;

export const WriteParams = Type.Object({
  path: Type.String({
    pattern: FILE_PATH.source,
    description:
      "Path of the file to write, relative to the repository root or absolute inside it; it must name a file, not a directory",
  }),
  content: Type.String({ description: "Content to write to the file" }),
});

type WriteInput = Static<typeof WriteParams>;

interface FileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
}

// The filesystem operations the tool needs. Not exported from the package: it lets tests simulate
// failures, such as EACCES, that a process running as root cannot produce.
export interface WriteFileSystem {
  access(path: RepoPath, mode: number): Promise<void>;
  lstat(path: RepoPath): Promise<FileStat>;
  mkdir(path: RepoPath): Promise<unknown>;
  open(path: RepoPath, flags: number, mode: number): Promise<WriteHandle>;
  realpath(path: RepoPath): Promise<string>;
  rename(from: RepoPath, to: RepoPath): Promise<void>;
  unlink(path: RepoPath): Promise<void>;
}

interface WriteHandle {
  writeFile(data: string, options: { encoding: "utf8"; signal: AbortSignal }): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

// O_EXCL refuses a temporary name that already exists, and O_NOFOLLOW refuses one swapped for a
// symbolic link. O_NOFOLLOW is undefined on Windows, where O_EXCL and the random name still keep
// the temporary file from replacing an existing entry. The file is created in the destination
// directory so the rename cannot cross a filesystem boundary.
const OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  ((constants.O_NOFOLLOW as number | undefined) ?? 0);
const DEFAULT_FILE_MODE = 0o666;

// TextEncoder encodes a lone surrogate as U+FFFD (3 bytes), matching what writeFile puts on
// disk; Buffer.byteLength reports the replacement differently on some runtimes.
const utf8 = new TextEncoder();

function describeBytes(content: string): string {
  const bytes = utf8.encode(content).byteLength;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

// Windows can briefly refuse a rename while an antivirus scanner or the search indexer holds the
// target; the same call usually succeeds a moment later.
const RENAME_ATTEMPTS = 4;
const RENAME_RETRY_MS = 20;
const RETRYABLE_RENAME: Record<string, true> = { EACCES: true, EBUSY: true, EPERM: true };

export function writeTool(): ExecutableTool<typeof WriteParams> {
  return writeToolWith(nodeFs);
}

export function writeToolWith(fs: WriteFileSystem): ExecutableTool<typeof WriteParams> {
  return {
    name: "write",
    description:
      "Create or replace a text file in the repository atomically. " +
      "Missing parent directories are created; a failed write leaves the original file unchanged.",
    parameters: WriteParams,
    mutation: "mutating",

    // Resolves the path through its deepest existing parent and checks the target's type without
    // creating anything, so the Approval that follows sees an operation that can run.
    async prepare(input, { workspace }): Promise<PrepareOutcome<typeof WriteParams>> {
      const invalid = checkInput(input);
      if (invalid !== undefined) return prepareFailure("SCHEMA_VIOLATION", invalid);
      const resolved = await workspace.resolveForCreate(input.path);
      if (!resolved.ok) {
        // resolveForCreate only returns NOT_FOUND when the path cannot be created: a parent is a
        // file, the name is invalid or too long, or a component disappeared. Write's contract
        // reports that as a failure to create the parent chain, not as a missing target.
        const code = resolved.code === "NOT_FOUND" ? "PARENT_CREATION_FAILED" : resolved.code;
        return prepareFailure(code, resolved.message);
      }
      const target = await inspectTarget(fs, resolved.path);
      if (!target.ok) return prepareFailure(target.failure.code, target.failure.message);
      const createsParents = target.mode === undefined && (await parentMissing(fs, resolved.path));
      const shown = relative(workspace.repoRoot, resolved.path) || ".";
      const action = target.mode === undefined ? "create" : "overwrite";
      const parents = createsParents ? "; creates parent directories" : "";
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: `${action} ${quote(shown)} (${describeBytes(input.content)})${parents}`,
        },
      };
    },

    // Re-resolves the path, since the filesystem may have changed since prepare.
    async execute({ input }, { workspace, signal }): Promise<ToolOutcome> {
      const resolved = await workspace.resolveForCreate(input.path);
      if (!resolved.ok) {
        const code = resolved.code === "NOT_FOUND" ? "PARENT_CREATION_FAILED" : resolved.code;
        return toolError(code, resolved.message);
      }
      return writeAtomically(fs, workspace.repoRoot, resolved.path, input.content, signal);
    },
  };
}

interface WriteFailure {
  readonly code: ToolErrorCode;
  readonly message: string;
}

// Schema Validation belongs to Agent Core (ADR 0001 §1); this repeats the schema's path rule so
// prepare never resolves a path the declaration forbids.
function checkInput({ path, content }: WriteInput): string | undefined {
  if (typeof path !== "string" || !FILE_PATH.test(path)) {
    return `path ${quote(String(path))} must be a non-empty path that names a file, not a directory`;
  }
  if (typeof content !== "string") return "content must be a string";
  return undefined;
}

// Whether prepare will create at least one parent directory. Looking at the immediate parent is
// enough: a missing ancestor implies a missing parent, and the resolver already rejects a file in
// the parent chain.
async function parentMissing(fs: WriteFileSystem, path: RepoPath): Promise<boolean> {
  try {
    await fs.lstat(dirname(path) as RepoPath);
    return false;
  } catch (cause) {
    if (errnoOf(cause) === "ENOENT") return true;
    if (errnoOf(cause) === "ENOTDIR") return false;
    throw cause;
  }
}

// Agent Core dispatches one Tool Call at a time and never asks for parallel tool calls (ADR 0002),
// so this tool needs no process-local mutation queue of its own; the atomic rename still keeps an
// external concurrent writer from exposing a partial file.
async function writeAtomically(
  fs: WriteFileSystem,
  repoRoot: RepoPath,
  path: RepoPath,
  content: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const created: RepoPath[] = [];
  const fail = (failure: WriteFailure): ToolOutcome =>
    toolError(failure.code, withCreatedDirectories(failure.message, repoRoot, created));

  try {
    signal.throwIfAborted();
    const parentProblem = await createParents(fs, repoRoot, path, created);
    if (parentProblem !== undefined) return fail(parentProblem);

    const target = await inspectTarget(fs, path);
    if (!target.ok) return fail(target.failure);

    const directory = dirname(path) as RepoPath;
    const directoryProblem = await inspectDirectory(fs, directory);
    if (directoryProblem !== undefined) return fail(directoryProblem);

    const temporary = join(directory, `.coding-agent-${randomUUID()}.tmp`) as RepoPath;
    let createdTemporary = false;
    let renamed = false;
    try {
      let handle: WriteHandle;
      try {
        handle = await fs.open(temporary, OPEN_FLAGS, target.mode ?? DEFAULT_FILE_MODE);
        createdTemporary = true;
      } catch (cause) {
        return fail(openFailure(directory, cause));
      }

      let writeError: unknown;
      try {
        await handle.writeFile(content, { encoding: "utf8", signal });
        // Renaming replaces the inode, so the previous permission bits are copied onto the temporary
        // file; setuid, setgid, and the sticky bit are deliberately dropped as a write would.
        if (target.mode !== undefined) await handle.chmod(target.mode);
        signal.throwIfAborted();
        // The rename must not publish content that a crash could still lose.
        await handle.sync();
      } catch (cause) {
        writeError = cause;
      }
      try {
        await handle.close();
      } catch (cause) {
        writeError ??= cause;
      }
      if (writeError !== undefined) return fail(writeFailure(path, writeError));
      signal.throwIfAborted();

      try {
        await renameWithRetry(fs, temporary, path, signal);
        renamed = true;
      } catch (cause) {
        return fail(renameFailure(path, cause));
      }
      return success(`${quote(path)} (${describeBytes(content)} written)`);
    } finally {
      if (createdTemporary && !renamed) await fs.unlink(temporary).catch(() => undefined);
    }
  } catch (cause) {
    // Failures with no ADR code (EIO, ENOSPC, EDQUOT, EFBIG) are rethrown so Agent Core reports
    // TOOL_INTERNAL_ERROR, but the directories created before the failure must still reach the
    // model. Cancellation keeps its original error so Agent Core can record it as cancelled.
    if (signal.aborted || (cause instanceof Error && cause.name === "AbortError")) throw cause;
    if (created.length === 0) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(withCreatedDirectories(detail, repoRoot, created), { cause });
  }
}

// Retries the rename a few times on the errors a Windows scanner or indexer produces while it
// briefly holds the target.
async function renameWithRetry(
  fs: WriteFileSystem,
  from: RepoPath,
  to: RepoPath,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      await fs.rename(from, to);
      return;
    } catch (cause) {
      const code = errnoOf(cause);
      if (attempt >= RENAME_ATTEMPTS || code === undefined || RETRYABLE_RENAME[code] !== true) {
        throw cause;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, RENAME_RETRY_MS * attempt);
      await promise;
    }
  }
}

// Creates each missing component with mkdir rather than a recursive call, which would follow a
// symbolic link swapped in after resolution. Directories created before a later failure are not
// rolled back, as ADR 0001 §5 accepts; writeAtomically reports them in the failure.
async function createParents(
  fs: WriteFileSystem,
  repoRoot: RepoPath,
  path: RepoPath,
  created: RepoPath[],
): Promise<WriteFailure | undefined> {
  const parent = dirname(path);
  const segments = relative(repoRoot, parent)
    .split(sep)
    .filter((segment) => segment !== "");
  let current: RepoPath = repoRoot;
  for (const segment of segments) {
    current = join(current, segment) as RepoPath;
    try {
      await fs.mkdir(current);
      created.push(current);
    } catch (cause) {
      if (errnoOf(cause) !== "EEXIST") return parentFailure(current, cause);
      let stats: FileStat;
      try {
        stats = await fs.lstat(current);
      } catch (error) {
        return parentFailure(current, error);
      }
      if (stats.isSymbolicLink()) return symbolicLinkFailure(current);
      if (!stats.isDirectory()) {
        return {
          code: "PARENT_CREATION_FAILED",
          message: `${quote(current)} cannot be created: a file is in the way`,
        };
      }
    }
    const problem = await inspectDirectory(fs, current);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

type TargetInspection =
  | { readonly ok: true; readonly mode?: number }
  | { readonly ok: false; readonly failure: WriteFailure };

// Checks the target before a temporary file exists, so an existing directory, a non-regular file,
// or a symlink swapped in after resolution fails without leaving a file behind. The permission
// bits of an existing regular file are preserved across the rename.
async function inspectTarget(fs: WriteFileSystem, path: RepoPath): Promise<TargetInspection> {
  try {
    const stats = await fs.lstat(path);
    if (stats.isSymbolicLink()) return { ok: false, failure: symbolicLinkFailure(path) };
    if (stats.isDirectory()) {
      return {
        ok: false,
        failure: { code: "IS_DIRECTORY", message: `${quote(path)} is a directory` },
      };
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        failure: { code: "PERMISSION_DENIED", message: `${quote(path)} is not a regular file` },
      };
    }
    // Rename only needs write access to the directory, so without these checks a read-only target
    // would be replaced silently. The mode check also catches 0444 for root, which bypasses
    // access(); access() catches owner/group permissions such as 0464.
    if ((stats.mode & 0o222) === 0) {
      return {
        ok: false,
        failure: { code: "PERMISSION_DENIED", message: `${quote(path)} is read-only` },
      };
    }
    try {
      await fs.access(path, constants.W_OK);
    } catch (cause) {
      switch (errnoOf(cause)) {
        case "EACCES":
        case "EPERM":
        case "EROFS":
          return {
            ok: false,
            failure: {
              code: "PERMISSION_DENIED",
              message: `${quote(path)} is not writable: permission denied`,
            },
          };
        case "ENOENT":
        case "ENOTDIR":
          // The target disappeared between lstat and access. Treat it as a create and let the
          // destination-directory check or the open report a parent that changed underneath.
          return { ok: true };
        case "ENAMETOOLONG":
          return {
            ok: false,
            failure: {
              code: "PARENT_CREATION_FAILED",
              message: `${quote(path)} is longer than the filesystem allows`,
            },
          };
        case "ELOOP":
          return { ok: false, failure: symbolicLinkFailure(path) };
        default:
          throw cause;
      }
    }
    return { ok: true, mode: stats.mode & 0o777 };
  } catch (cause) {
    switch (errnoOf(cause)) {
      case "ENOENT":
        return { ok: true };
      case "ENOTDIR":
        return {
          ok: false,
          failure: {
            code: "PARENT_CREATION_FAILED",
            message: `${quote(path)} cannot be reached: a parent is not a directory`,
          },
        };
      case "EACCES":
      case "EPERM":
        return {
          ok: false,
          failure: {
            code: "PERMISSION_DENIED",
            message: `${quote(path)} cannot be inspected: permission denied`,
          },
        };
      case "ENAMETOOLONG":
        return {
          ok: false,
          failure: {
            code: "PARENT_CREATION_FAILED",
            message: `${quote(path)} is longer than the filesystem allows`,
          },
        };
      case "ELOOP":
        return { ok: false, failure: symbolicLinkFailure(path) };
      default:
        throw cause;
    }
  }
}

// The resolver verifies the lexical path before creation and createParents checks every component
// it creates, but a parent can still be swapped for a symbolic link after those checks. Requiring
// the destination directory to canonicalize to itself catches that before the temporary file is
// opened. This narrows but does not close the race: the remaining window is the TOCTOU gap the
// workspace resolver documents for CDA-50/58, and ADR 0004 keeps it small by re-resolving in
// execute.
async function inspectDirectory(
  fs: WriteFileSystem,
  directory: RepoPath,
): Promise<WriteFailure | undefined> {
  try {
    if ((await fs.realpath(directory)) !== directory) {
      return {
        code: "PATH_OUTSIDE_REPO",
        message: `${quote(directory)} changed while being created; symbolic links are not followed`,
      };
    }
    return undefined;
  } catch (cause) {
    switch (errnoOf(cause)) {
      case "ENOENT":
      case "ENOTDIR":
        return {
          code: "PARENT_CREATION_FAILED",
          message: `${quote(directory)} disappeared while being created`,
        };
      case "EACCES":
      case "EPERM":
        return {
          code: "PERMISSION_DENIED",
          message: `${quote(directory)} cannot be inspected: permission denied`,
        };
      case "ELOOP":
        return symbolicLinkFailure(directory);
      case "ENAMETOOLONG":
        return {
          code: "PARENT_CREATION_FAILED",
          message: `${quote(directory)} is longer than the filesystem allows`,
        };
      case "EINVAL":
        return {
          code: "PARENT_CREATION_FAILED",
          message: `${quote(directory)} is not a valid path on this platform`,
        };
      default:
        throw cause;
    }
  }
}

// Maps the expected failures to the port's codes. Anything else, including EIO and the capacity
// errors ENOSPC, EDQUOT, and EFBIG, is rethrown so Agent Core reports TOOL_INTERNAL_ERROR with the
// OS message; ADR 0001 has no code for them, and adding one would be an ADR change outside CDA-62.
function parentFailure(path: RepoPath, cause: unknown): WriteFailure {
  switch (errnoOf(cause)) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return {
        code: "PARENT_CREATION_FAILED",
        message: `${quote(path)} cannot be created: permission denied`,
      };
    case "ENOENT":
    case "ENOTDIR":
      return {
        code: "PARENT_CREATION_FAILED",
        message: `${quote(path)} disappeared while being created`,
      };
    case "ELOOP":
      return symbolicLinkFailure(path);
    case "ENAMETOOLONG":
      return {
        code: "PARENT_CREATION_FAILED",
        message: `${quote(path)} is longer than the filesystem allows`,
      };
    default:
      throw cause;
  }
}

function openFailure(directory: RepoPath, cause: unknown): WriteFailure {
  switch (errnoOf(cause)) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(directory)} cannot be written: permission denied`,
      };
    case "ENOENT":
    case "ENOTDIR":
      return {
        code: "PARENT_CREATION_FAILED",
        message: `${quote(directory)} disappeared while writing`,
      };
    case "ELOOP":
      return symbolicLinkFailure(directory);
    default:
      throw cause;
  }
}

function writeFailure(path: RepoPath, cause: unknown): WriteFailure {
  switch (errnoOf(cause)) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(path)} cannot be written: permission denied`,
      };
    default:
      throw cause;
  }
}

function renameFailure(path: RepoPath, cause: unknown): WriteFailure {
  switch (errnoOf(cause)) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(path)} cannot be replaced: permission denied`,
      };
    case "EISDIR":
      return { code: "IS_DIRECTORY", message: `${quote(path)} is a directory` };
    case "ENOENT":
    case "ENOTDIR":
      return {
        code: "PARENT_CREATION_FAILED",
        message: `${quote(path)} disappeared before it could be replaced`,
      };
    case "ELOOP":
      return symbolicLinkFailure(path);
    default:
      throw cause;
  }
}

function symbolicLinkFailure(path: RepoPath): WriteFailure {
  return {
    code: "PATH_OUTSIDE_REPO",
    message: `${quote(path)} is a symbolic link; symbolic links are not followed`,
  };
}

// ADR 0001 §5 accepts that created directories are not rolled back; the Tool Result must report
// them so the model knows what remains after a failure.
function withCreatedDirectories(
  message: string,
  repoRoot: RepoPath,
  created: readonly RepoPath[],
): string {
  if (created.length === 0) return message;
  const shown = created.map((directory) => quote(relative(repoRoot, directory))).join(", ");
  return `${message}; created directories: ${shown}`;
}

// The canonical path can hold any character but "/" and NUL, so it is quoted to keep a name with
// a newline from passing for a result line.
function quote(path: string): string {
  return JSON.stringify(path);
}

function success(content: string): ToolOutcome {
  return { isError: false, content };
}

function toolError(code: ToolErrorCode, message: string): ToolOutcome {
  return { isError: true, content: message, error: { code, message } };
}

function prepareFailure(code: ToolErrorCode, message: string): PrepareOutcome<typeof WriteParams> {
  return { ok: false, code, message };
}
