import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { relative } from "node:path";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolErrorCode,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import { errnoOf } from "./errno.ts";

// ADR 0001's read default: the number of lines returned when the model gives no limit.
const DEFAULT_LIMIT = 300;

export const ReadParams = Type.Object({
  path: Type.String({ description: "Path of the file to read, relative to the repository root" }),
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: "1-based line number to start reading from" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Maximum number of lines to read (default ${DEFAULT_LIMIT})`,
    }),
  ),
});

type ReadInput = Static<typeof ReadParams>;

// The filesystem operation the tool needs. Not exported from the package: it lets tests simulate
// failures, such as EACCES, that a process running as root cannot produce.
export interface ReadFileSystem {
  open(path: RepoPath, flags: number): Promise<ReadHandle>;
}

interface ReadHandle {
  stat(): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readFile(options: { encoding: "utf8"; signal: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

// O_NOFOLLOW refuses a final component swapped for a symbolic link after resolution, and
// O_NONBLOCK keeps opening a FIFO from waiting for a writer that never comes. Windows defines
// neither flag, where the resolver still rejects symbolic links before the open.
const OPEN_FLAGS =
  constants.O_RDONLY |
  ((constants.O_NOFOLLOW as number | undefined) ?? 0) |
  ((constants.O_NONBLOCK as number | undefined) ?? 0);

export function readTool(): ExecutableTool<typeof ReadParams> {
  return readToolWith(nodeFs);
}

export function readToolWith(fs: ReadFileSystem): ExecutableTool<typeof ReadParams> {
  return {
    name: "read",
    description:
      "Read a text file in the repository. Returns numbered lines (`line | content`), " +
      `${DEFAULT_LIMIT} at most unless a limit is given; use offset to continue further down.`,
    parameters: ReadParams,
    mutation: "read_only",

    async prepare(input, { workspace }): Promise<PrepareOutcome<typeof ReadParams>> {
      const invalid = checkWindow(input);
      if (invalid !== undefined) return prepareFailure("SCHEMA_VIOLATION", invalid);
      const resolved = await workspace.resolveExisting(input.path);
      if (!resolved.ok) return resolved;
      const first = input.offset ?? 1;
      const last = first + (input.limit ?? DEFAULT_LIMIT) - 1;
      const shown = relative(workspace.repoRoot, resolved.path) || ".";
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: `read ${shown} (lines ${first}-${last})`,
        },
      };
    },

    // Re-resolves the path, since the filesystem may have changed since prepare.
    async execute({ input }, { workspace, signal }): Promise<ToolOutcome> {
      const resolved = await workspace.resolveExisting(input.path);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const text = await readText(fs, resolved.path, signal);
      if (typeof text !== "string") return toolError(text.code, text.message);
      return render(resolved.path, text, input);
    },
  };
}

// Schema Validation belongs to Agent Core (ADR 0001 §1); this repeats the window checks so the
// tool never reads with an offset or limit the schema forbids.
function checkWindow({ offset, limit }: ReadInput): string | undefined {
  if (offset !== undefined && !(Number.isInteger(offset) && offset >= 1)) {
    return `offset must be an integer of at least 1, got ${offset}`;
  }
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    return `limit must be an integer of at least 1, got ${limit}`;
  }
  return undefined;
}

interface ReadFailure {
  readonly code: ToolErrorCode;
  readonly message: string;
}

// Opens before checking the file's type, so the check applies to the file actually read. The
// resolver does not check readability, so EACCES and EPERM from the open itself are mapped here.
// A FIFO reaches the stat below because O_NONBLOCK makes the open succeed; a socket does not,
// because the kernel refuses to open it with ENXIO.
async function readText(
  fs: ReadFileSystem,
  path: RepoPath,
  signal: AbortSignal,
): Promise<string | ReadFailure> {
  let handle: ReadHandle;
  try {
    handle = await fs.open(path, OPEN_FLAGS);
  } catch (cause) {
    return openFailure(path, cause);
  }
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) return isDirectory(path);
    if (!stats.isFile()) return notRegularFile(path);
    return await handle.readFile({ encoding: "utf8", signal });
  } finally {
    // The file was only read, so a failure to close it must not replace the outcome.
    await handle.close().catch(() => undefined);
  }
}

// Anything other than the expected failures is rethrown so Agent Core reports TOOL_INTERNAL_ERROR.
function openFailure(path: RepoPath, cause: unknown): ReadFailure {
  switch (errnoOf(cause)) {
    case "ENOENT":
    case "ENOTDIR":
      return { code: "NOT_FOUND", message: `${quote(path)} does not exist` };
    case "EISDIR":
      return isDirectory(path);
    case "ENXIO":
      // The kernel reports a socket this way; like a FIFO, it is not a regular file.
      return notRegularFile(path);
    case "ELOOP":
      return {
        code: "PATH_OUTSIDE_REPO",
        message: `${quote(path)} is a symbolic link; symbolic links are not followed`,
      };
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

function isDirectory(path: RepoPath): ReadFailure {
  return { code: "IS_DIRECTORY", message: `${quote(path)} is a directory` };
}

function notRegularFile(path: RepoPath): ReadFailure {
  return { code: "PERMISSION_DENIED", message: `${quote(path)} is not a regular file` };
}

// The canonical path can hold any character but "/" and NUL, so it is quoted to keep a name with
// a newline from passing for a numbered line.
function quote(path: RepoPath): string {
  return JSON.stringify(path);
}

function render(
  path: RepoPath,
  text: string,
  { offset = 1, limit = DEFAULT_LIMIT }: ReadInput,
): ToolOutcome {
  const all = splitLines(text);
  if (all.length === 0 && offset === 1) return success(`${quote(path)} (empty file)`);
  if (offset > all.length) {
    return toolError(
      "SCHEMA_VIOLATION",
      `offset ${offset} is past the end of ${quote(path)}, which has ${all.length} lines`,
    );
  }
  const shown = all.slice(offset - 1, offset - 1 + limit);
  const last = offset + shown.length - 1;
  const width = String(last).length;
  const numbered = shown.map(
    (line, index) => `${String(offset + index).padStart(width)} | ${line}`,
  );
  const remaining = all.length - last;
  const more = remaining > 0 ? [`[${remaining} more lines; continue with offset ${last + 1}]`] : [];
  return success(
    [`${quote(path)} (lines ${offset}-${last} of ${all.length})`, ...numbered, ...more].join("\n"),
  );
}

// A trailing newline ends the last line rather than starting an empty one.
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function success(content: string): ToolOutcome {
  return { isError: false, content };
}

function toolError(code: ToolErrorCode, message: string): ToolOutcome {
  return { isError: true, content: message, error: { code, message } };
}

function prepareFailure(code: ToolErrorCode, message: string): PrepareOutcome<typeof ReadParams> {
  return { ok: false, code, message };
}
