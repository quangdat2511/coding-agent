import * as nodeFs from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolError,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import {
  type FileStat,
  inspectDirectory,
  inspectTarget,
  replaceAtomically,
  type WriteFileSystem,
} from "./atomic-write.ts";
import { errnoOf } from "./errno.ts";
import { symbolicLinkFailure } from "./failures.ts";
import { describeBytes, displayPath, quote } from "./messages.ts";
import { checkFilePath, FILE_PATH_PATTERN } from "./paths.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { prepareFailure, success, toolError } from "./tool-outcome.ts";

export const WriteParams = Type.Object({
  path: Type.String({
    pattern: FILE_PATH_PATTERN.source,
    description:
      "Path of the file to write, relative to the repository root or absolute inside it; it must name a file, not a directory",
  }),
  content: Type.String({ description: "Content to write to the file" }),
});

type WriteInput = Static<typeof WriteParams>;

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
      if (invalid !== undefined) {
        return prepareFailure<typeof WriteParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
      const resolved = await workspace.resolveForCreate(input.path);
      if (!resolved.ok) {
        // resolveForCreate only returns NOT_FOUND when the path cannot be created: a parent is a
        // file, the name is invalid or too long, or a component disappeared. Write's contract
        // reports that as a failure to create the parent chain, not as a missing target.
        const code = resolved.code === "NOT_FOUND" ? "PARENT_CREATION_FAILED" : resolved.code;
        return prepareFailure<typeof WriteParams>({ code, message: resolved.message });
      }
      const target = await inspectTarget(fs, resolved.path);
      if (!target.ok) return prepareFailure<typeof WriteParams>(target.error);
      const creates = target.kind === "missing";
      const createsParents = creates && (await parentMissing(fs, resolved.path));
      const shown = displayPath(workspace.repoRoot, resolved.path);
      const action = creates ? "create" : "overwrite";
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

    // Re-validates the prepared path, since the filesystem may have changed since prepare.
    async execute(prepared, { workspace, signal }): Promise<ToolOutcome> {
      const validated = await revalidatePreparedPath(prepared.paths, (path) =>
        workspace.resolveForCreate(path),
      );
      if (!validated.ok) {
        const code = validated.code === "NOT_FOUND" ? "PARENT_CREATION_FAILED" : validated.code;
        return toolError({ code, message: validated.message });
      }
      return writeAtomically(
        fs,
        workspace.repoRoot,
        validated.path,
        prepared.input.content,
        signal,
      );
    },
  };
}

// Schema Validation belongs to Agent Core (ADR 0001 §1); this repeats the schema's path rule so
// prepare never resolves a path the declaration forbids.
function checkInput({ path, content }: WriteInput): string | undefined {
  const invalidPath = checkFilePath(path);
  if (invalidPath !== undefined) return invalidPath;
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

async function writeAtomically(
  fs: WriteFileSystem,
  repoRoot: RepoPath,
  path: RepoPath,
  content: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const created: RepoPath[] = [];
  const fail = (error: ToolError): ToolOutcome =>
    toolError({
      code: error.code,
      message: withCreatedDirectories(error.message, repoRoot, created),
    });

  try {
    signal.throwIfAborted();
    const parentProblem = await createParents(fs, repoRoot, path, created);
    if (parentProblem !== undefined) return fail(parentProblem);
    const written = await replaceAtomically(fs, path, content, { signal, createMissing: true });
    if (!written.ok) return fail(written.error);
    return success(`${quote(path)} (${describeBytes(content)} written)`);
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

// Creates each missing component with mkdir rather than a recursive call, which would follow a
// symbolic link swapped in after resolution. Directories created before a later failure are not
// rolled back, as ADR 0001 §5 accepts; writeAtomically reports them in the failure.
async function createParents(
  fs: WriteFileSystem,
  repoRoot: RepoPath,
  path: RepoPath,
  created: RepoPath[],
): Promise<ToolError | undefined> {
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

// Maps the expected failures to the port's codes. Anything else, including EIO and the capacity
// errors ENOSPC, EDQUOT, and EFBIG, is rethrown so Agent Core reports TOOL_INTERNAL_ERROR with the
// OS message; ADR 0001 has no code for them, and adding one would be an ADR change outside CDA-62.
function parentFailure(path: RepoPath, cause: unknown): ToolError {
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
