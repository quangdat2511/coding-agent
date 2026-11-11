import { constants } from "node:fs";
import type { RepoPath, ToolError } from "@coding-agent/agent-core";
import { errnoOf } from "./errno.ts";
import { directoryFailure, notRegularFileFailure, symbolicLinkFailure } from "./failures.ts";
import { quote } from "./messages.ts";

// The filesystem operations reading a file needs. Not exported from the package: it lets tests
// simulate failures, such as EACCES, that a process running as root cannot produce.
export interface ReadFileSystem {
  open(path: RepoPath, flags: number): Promise<ReadHandle>;
  lstat(path: RepoPath): Promise<{ isSocket(): boolean }>;
}

export interface ReadHandle {
  stat(): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readFile(options: { signal: AbortSignal }): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ReadTextOptions {
  // Whether bytes that are not valid UTF-8 fail the read. `read` can show them as U+FFFD, which
  // loses nothing on screen. `edit` writes the text back, so a replacement character would
  // silently rewrite every invalid byte in the file, including ones outside the matched text.
  readonly invalidUtf8: "replace" | "reject";
}

// O_NOFOLLOW refuses a final component swapped for a symbolic link after resolution, and
// O_NONBLOCK keeps opening a FIFO from waiting for a writer that never comes. Windows defines
// neither flag, where the resolver still rejects symbolic links before the open. Exported so that
// a caller that reads a file the read tool could read opens it the same way.
export const READ_OPEN_FLAGS =
  constants.O_RDONLY |
  ((constants.O_NOFOLLOW as number | undefined) ?? 0) |
  ((constants.O_NONBLOCK as number | undefined) ?? 0);

// Reads a regular text file. Opens before checking the file's type, so the check applies to the
// file actually read. The resolver does not check readability, so EACCES and EPERM from the open
// itself are mapped here. A FIFO reaches the stat below because O_NONBLOCK makes the open succeed;
// a socket does not, because the kernel refuses to open it.
export async function readTextFile(
  fs: ReadFileSystem,
  path: RepoPath,
  signal: AbortSignal,
  { invalidUtf8 }: ReadTextOptions,
): Promise<string | ToolError> {
  let handle: ReadHandle;
  try {
    handle = await fs.open(path, READ_OPEN_FLAGS);
  } catch (cause) {
    // macOS refuses to open a socket with EOPNOTSUPP, which a network or FUSE mount can also
    // return for an ordinary file that does not support one of the open flags.
    if (errnoOf(cause) === "EOPNOTSUPP" && (await isSocket(fs, path))) {
      return notRegularFileFailure(path);
    }
    return openReadFailure(path, cause);
  }
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) return directoryFailure(path);
    if (!stats.isFile()) return notRegularFileFailure(path);
    const bytes = await handle.readFile({ signal });
    // ignoreBOM keeps a leading byte order mark as a character. Dropping it would change the
    // file's first bytes, which matters as soon as the text is written back.
    if (invalidUtf8 === "replace") {
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { code: "PERMISSION_DENIED", message: `${quote(path)} is not valid UTF-8 text` };
    }
  } finally {
    // The file was only read, so a failure to close it must not replace the outcome.
    await handle.close().catch(() => undefined);
  }
}

async function isSocket(fs: ReadFileSystem, path: RepoPath): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isSocket();
  } catch {
    return false;
  }
}

// Anything other than the expected failures is rethrown so Agent Core reports TOOL_INTERNAL_ERROR.
function openReadFailure(path: RepoPath, cause: unknown): ToolError {
  switch (errnoOf(cause)) {
    case "ENOENT":
    case "ENOTDIR":
      return { code: "NOT_FOUND", message: `${quote(path)} does not exist` };
    case "EISDIR":
      return directoryFailure(path);
    case "ENXIO":
      // Linux reports a socket this way; like a FIFO, it is not a regular file.
      return notRegularFileFailure(path);
    case "ELOOP":
      return symbolicLinkFailure(path);
    case "EACCES":
    case "EPERM":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(path)} cannot be read: permission denied`,
      };
    default:
      throw cause;
  }
}
