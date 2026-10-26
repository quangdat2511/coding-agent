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
      "Path of the file to write, relative to the repository root; it must name a file, not a directory",
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
  lstat(path: RepoPath): Promise<FileStat>;
  mkdir(path: RepoPath): Promise<unknown>;
  open(path: RepoPath, flags: number, mode: number): Promise<WriteHandle>;
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
      if (!resolved.ok) return resolved;
      const target = await inspectTarget(fs, resolved.path);
      if (!target.ok) return prepareFailure(target.failure.code, target.failure.message);
      const shown = relative(workspace.repoRoot, resolved.path) || ".";
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: `write ${shown} (${Buffer.byteLength(input.content, "utf8")} bytes)`,
        },
      };
    },

    // Re-resolves the path, since the filesystem may have changed since prepare.
    async execute({ input }, { workspace, signal }): Promise<ToolOutcome> {
      const resolved = await workspace.resolveForCreate(input.path);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
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

async function writeAtomically(
  fs: WriteFileSystem,
  repoRoot: RepoPath,
  path: RepoPath,
  content: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  signal.throwIfAborted();
  const parentProblem = await createParents(fs, repoRoot, path);
  if (parentProblem !== undefined) return toolError(parentProblem.code, parentProblem.message);

  const target = await inspectTarget(fs, path);
  if (!target.ok) return toolError(target.failure.code, target.failure.message);

  const directory = dirname(path) as RepoPath;
  const temporary = join(directory, `.coding-agent-${randomUUID()}.tmp`) as RepoPath;
  let created = false;
  let renamed = false;
  try {
    let handle: WriteHandle;
    try {
      handle = await fs.open(temporary, OPEN_FLAGS, target.mode ?? DEFAULT_FILE_MODE);
      created = true;
    } catch (cause) {
      const failure = openFailure(directory, cause);
      return toolError(failure.code, failure.message);
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
    if (writeError !== undefined) {
      const failure = writeFailure(path, writeError);
      return toolError(failure.code, failure.message);
    }
    signal.throwIfAborted();

    try {
      await renameWithRetry(fs, temporary, path);
      renamed = true;
    } catch (cause) {
      const failure = renameFailure(path, cause);
      return toolError(failure.code, failure.message);
    }
    return success(`${quote(path)} (${Buffer.byteLength(content, "utf8")} bytes written)`);
  } finally {
    if (created && !renamed) await fs.unlink(temporary).catch(() => undefined);
  }
}

// Retries the rename a few times on the errors a Windows scanner or indexer produces while it
// briefly holds the target.
async function renameWithRetry(fs: WriteFileSystem, from: RepoPath, to: RepoPath): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (cause) {
      const code = errnoOf(cause);
      if (attempt >= RENAME_ATTEMPTS || (code !== undefined && RETRYABLE_RENAME[code] !== true)) {
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
// rolled back, as ADR 0001 §5 accepts.
async function createParents(
  fs: WriteFileSystem,
  repoRoot: RepoPath,
  path: RepoPath,
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
      continue;
    } catch (cause) {
      if (errnoOf(cause) !== "EEXIST") return parentFailure(current, cause);
    }
    let stats: FileStat;
    try {
      stats = await fs.lstat(current);
    } catch (cause) {
      return parentFailure(current, cause);
    }
    if (stats.isSymbolicLink()) return symbolicLinkFailure(current);
    if (!stats.isDirectory()) {
      return {
        code: "PARENT_CREATION_FAILED",
        message: `${quote(current)} cannot be created: a file is in the way`,
      };
    }
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
      case "ELOOP":
        return { ok: false, failure: symbolicLinkFailure(path) };
      default:
        throw cause;
    }
  }
}

// Maps the expected failures to the port's codes; anything else is rethrown so Agent Core reports
// TOOL_INTERNAL_ERROR.
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
