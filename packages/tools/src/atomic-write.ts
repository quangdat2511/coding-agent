import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { RepoPath, ToolError } from "@coding-agent/agent-core";
import { errnoOf } from "./errno.ts";
import { directoryFailure, notRegularFileFailure, symbolicLinkFailure } from "./failures.ts";
import { quote } from "./messages.ts";

export interface FileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
}

// The filesystem operations replacing a file needs. Not exported from the package: it lets tests
// simulate failures, such as EACCES, that a process running as root cannot produce.
export interface WriteFileSystem {
  access(path: RepoPath, mode: number): Promise<void>;
  lstat(path: RepoPath): Promise<FileStat>;
  mkdir(path: RepoPath): Promise<unknown>;
  open(path: RepoPath, flags: number, mode: number): Promise<WriteHandle>;
  realpath(path: RepoPath): Promise<string>;
  rename(from: RepoPath, to: RepoPath): Promise<void>;
  unlink(path: RepoPath): Promise<void>;
}

export interface WriteHandle {
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

export type TargetInspection =
  | { readonly ok: true; readonly kind: "missing" }
  | { readonly ok: true; readonly kind: "file"; readonly mode: number }
  | { readonly ok: false; readonly error: ToolError };

// Checks the target before a temporary file exists, so an existing directory, a non-regular file,
// or a symlink swapped in after resolution fails without leaving a file behind. The permission
// bits of an existing regular file are preserved across the rename.
export async function inspectTarget(
  fs: WriteFileSystem,
  path: RepoPath,
): Promise<TargetInspection> {
  try {
    const stats = await fs.lstat(path);
    if (stats.isSymbolicLink()) return { ok: false, error: symbolicLinkFailure(path) };
    if (stats.isDirectory()) return { ok: false, error: directoryFailure(path) };
    if (!stats.isFile()) return { ok: false, error: notRegularFileFailure(path) };
    // Rename only needs write access to the directory, so without these checks a read-only target
    // would be replaced silently. The mode check also catches 0444 for root, which bypasses
    // access(); access() catches owner/group permissions such as 0464.
    if ((stats.mode & 0o222) === 0) {
      return {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: `${quote(path)} is read-only` },
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
            error: {
              code: "PERMISSION_DENIED",
              message: `${quote(path)} is not writable: permission denied`,
            },
          };
        case "ENOENT":
        case "ENOTDIR":
          // The target disappeared between lstat and access. Treat it as missing and let the
          // caller decide whether it may be created.
          return { ok: true, kind: "missing" };
        case "ENAMETOOLONG":
          return {
            ok: false,
            error: {
              code: "PARENT_CREATION_FAILED",
              message: `${quote(path)} is longer than the filesystem allows`,
            },
          };
        case "ELOOP":
          return { ok: false, error: symbolicLinkFailure(path) };
        default:
          throw cause;
      }
    }
    return { ok: true, kind: "file", mode: stats.mode & 0o777 };
  } catch (cause) {
    switch (errnoOf(cause)) {
      case "ENOENT":
        return { ok: true, kind: "missing" };
      case "ENOTDIR":
        return {
          ok: false,
          error: {
            code: "PARENT_CREATION_FAILED",
            message: `${quote(path)} cannot be reached: a parent is not a directory`,
          },
        };
      case "EACCES":
      case "EPERM":
        return {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: `${quote(path)} cannot be inspected: permission denied`,
          },
        };
      case "ENAMETOOLONG":
        return {
          ok: false,
          error: {
            code: "PARENT_CREATION_FAILED",
            message: `${quote(path)} is longer than the filesystem allows`,
          },
        };
      case "ELOOP":
        return { ok: false, error: symbolicLinkFailure(path) };
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
export async function inspectDirectory(
  fs: WriteFileSystem,
  directory: RepoPath,
): Promise<ToolError | undefined> {
  try {
    if ((await fs.realpath(directory)) !== directory) {
      return {
        code: "PATH_OUTSIDE_REPO",
        message: `${quote(directory)} changed after it was resolved; symbolic links are not followed`,
      };
    }
    return undefined;
  } catch (cause) {
    switch (errnoOf(cause)) {
      case "ENOENT":
      case "ENOTDIR":
        return {
          code: "PARENT_CREATION_FAILED",
          message: `${quote(directory)} disappeared before it could be written`,
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

export interface AtomicWriteOptions {
  readonly signal: AbortSignal;
  // Whether a target that does not exist yet may be created. `write` creates it; `edit` reports
  // NOT_FOUND instead, because it can only replace text in a file that already exists.
  readonly createMissing: boolean;
}

export type AtomicWriteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ToolError };

// Replaces a file's content through a temporary file in the destination directory and an atomic
// rename, so a failure never leaves a half-written file. Re-inspects the target and its directory
// first, since waiting for Approval leaves time for the filesystem to change.
//
// Agent Core dispatches one Tool Call at a time and never asks for parallel tool calls
// (ADR 0002), so this needs no process-local mutation queue of its own; the atomic rename still
// keeps an external concurrent writer from exposing a partial file.
export async function replaceAtomically(
  fs: WriteFileSystem,
  path: RepoPath,
  content: string,
  { signal, createMissing }: AtomicWriteOptions,
): Promise<AtomicWriteOutcome> {
  signal.throwIfAborted();
  const target = await inspectTarget(fs, path);
  if (!target.ok) return { ok: false, error: target.error };
  if (target.kind === "missing" && !createMissing) {
    return { ok: false, error: { code: "NOT_FOUND", message: `${quote(path)} does not exist` } };
  }

  const directory = dirname(path) as RepoPath;
  const directoryProblem = await inspectDirectory(fs, directory);
  if (directoryProblem !== undefined) {
    // Only a tool that may create the target can report a parent it failed to create. A tool that
    // may only replace an existing file, such as edit, reports the vanished directory as the
    // missing target it is.
    if (!createMissing && directoryProblem.code === "PARENT_CREATION_FAILED") {
      return { ok: false, error: { code: "NOT_FOUND", message: `${quote(path)} does not exist` } };
    }
    return { ok: false, error: directoryProblem };
  }

  const temporary = join(directory, `.coding-agent-${randomUUID()}.tmp`) as RepoPath;
  let createdTemporary = false;
  let renamed = false;
  try {
    let handle: WriteHandle;
    try {
      const mode = target.kind === "file" ? target.mode : DEFAULT_FILE_MODE;
      handle = await fs.open(temporary, OPEN_FLAGS, mode);
      createdTemporary = true;
    } catch (cause) {
      return { ok: false, error: openTemporaryFailure(directory, cause) };
    }

    let writeError: unknown;
    try {
      await handle.writeFile(content, { encoding: "utf8", signal });
      // Renaming replaces the inode, so the previous permission bits are copied onto the temporary
      // file; setuid, setgid, and the sticky bit are deliberately dropped as a write would.
      if (target.kind === "file") await handle.chmod(target.mode);
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
    if (writeError !== undefined) return { ok: false, error: writeFailure(path, writeError) };
    signal.throwIfAborted();

    try {
      await renameWithRetry(fs, temporary, path, signal);
      renamed = true;
    } catch (cause) {
      return { ok: false, error: renameFailure(path, cause) };
    }
    return { ok: true };
  } finally {
    if (createdTemporary && !renamed) await fs.unlink(temporary).catch(() => undefined);
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

// Anything other than the expected failures is rethrown so Agent Core reports TOOL_INTERNAL_ERROR.
function openTemporaryFailure(directory: RepoPath, cause: unknown): ToolError {
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

function writeFailure(path: RepoPath, cause: unknown): ToolError {
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

function renameFailure(path: RepoPath, cause: unknown): ToolError {
  switch (errnoOf(cause)) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(path)} cannot be replaced: permission denied`,
      };
    case "EISDIR":
      return directoryFailure(path);
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
