import * as nodeFs from "node:fs/promises";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolError,
  ToolErrorCode,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { inspectTarget, replaceAtomically, type WriteFileSystem } from "./atomic-write.ts";
import { applyEdits } from "./edit-content.ts";
import {
  checkEditInput,
  type EditInput,
  EditParams,
  normalizeEditArguments,
} from "./edit-input.ts";
import { displayPath, quote } from "./messages.ts";
import { boundToolOutput } from "./output-budget.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { type ReadFileSystem, readTextFile } from "./text-file.ts";
import { prepareFailure, success, toolError } from "./tool-outcome.ts";

export { EditParams } from "./edit-input.ts";

export function editTool(): ExecutableTool<typeof EditParams> {
  return editToolWith(nodeFs, nodeFs);
}

// Reading and writing take different handles, so the tool takes one of each. Not exported from the
// package: it lets tests simulate failures, such as EACCES, that a process running as root cannot
// produce.
export function editToolWith(
  readFs: ReadFileSystem,
  writeFs: WriteFileSystem,
): ExecutableTool<typeof EditParams> {
  return {
    name: "edit",
    description:
      "Replace disjoint ranges in an existing file atomically. " +
      "Each oldText must match a unique range in the original file.",
    parameters: EditParams,
    mutation: "mutating",
    normalizeArguments: normalizeEditArguments,

    // Counts the matches and checks the target without changing anything, so an edit that cannot
    // apply fails before the Approval rather than after it.
    async prepare(input, { workspace, signal }): Promise<PrepareOutcome<typeof EditParams>> {
      const invalid = checkEditInput(input);
      if (invalid !== undefined) {
        return prepareFailure<typeof EditParams>({
          code: "SCHEMA_VIOLATION",
          message: invalid.message,
        });
      }
      const resolved = await workspace.resolveExisting(input.path);
      if (!resolved.ok) return prepareFailure<typeof EditParams>(asEditFileError(resolved));
      const target = await inspectTarget(writeFs, resolved.path);
      if (!target.ok) return prepareFailure<typeof EditParams>(asEditFileError(target.error));
      const replaced = await readAndApplyEdits(readFs, resolved.path, input, signal);
      if (!replaced.ok) return prepareFailure<typeof EditParams>(replaced.error);
      const shown = displayPath(workspace.repoRoot, resolved.path);
      const count = input.edits.length;
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: `Apply ${count} requested ${count === 1 ? "edit" : "edits"} to ${quote(shown)}`,
        },
      };
    },

    // Re-validates the prepared path and re-reads the file, since the filesystem may have changed.
    async execute(prepared, { workspace, signal }): Promise<ToolOutcome> {
      const validated = await revalidatePreparedPath(prepared.paths, (path) =>
        workspace.resolveExisting(path),
      );
      if (!validated.ok) return toolError(asEditFileError(validated));
      const replaced = await readAndApplyEdits(readFs, validated.path, prepared.input, signal);
      if (!replaced.ok) return toolError(replaced.error);
      const written = await replaceAtomically(writeFs, validated.path, replaced.content, {
        signal,
        createMissing: false,
      });
      if (!written.ok) return toolError(asEditFileError(written.error));
      const { changed } = replaced;
      return success(
        `${quote(validated.path)} (${changed} ${changed === 1 ? "replacement" : "replacements"} applied)`,
      );
    },
  };
}

const fileCorrections: Partial<Record<ToolErrorCode, string>> = {
  NOT_FOUND: "Supply the path of an existing file inside the repository.",
  IS_DIRECTORY: "Choose a file inside that directory.",
  PATH_OUTSIDE_REPO: "Choose a file inside the repository with no symbolic links in its path.",
  PERMISSION_DENIED: "Choose a readable, writable regular UTF-8 file.",
};

function asEditFileError(error: ToolError): ToolError {
  // Edit only works on existing files, so a parent that cannot be reached is NOT_FOUND.
  const code = error.code === "PARENT_CREATION_FAILED" ? "NOT_FOUND" : error.code;
  const correction = fileCorrections[code];
  const message = correction === undefined ? error.message : `${error.message}. ${correction}`;
  return { code, message: boundToolOutput(message).content };
}

async function readAndApplyEdits(
  fs: ReadFileSystem,
  path: RepoPath,
  input: EditInput,
  signal: AbortSignal,
): Promise<ReturnType<typeof applyEdits>> {
  const current = await readTextFile(fs, path, signal, { invalidUtf8: "reject" });
  if (typeof current !== "string") return { ok: false, error: asEditFileError(current) };
  return applyEdits(current, path, input.edits);
}
