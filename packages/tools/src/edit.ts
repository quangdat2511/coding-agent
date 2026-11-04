import * as nodeFs from "node:fs/promises";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolError,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import { inspectTarget, replaceAtomically, type WriteFileSystem } from "./atomic-write.ts";
import { describeBytes, displayPath, preview, quote } from "./messages.ts";
import { checkFilePath, FILE_PATH_PATTERN } from "./paths.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { type ReadFileSystem, readTextFile } from "./text-file.ts";
import { prepareFailure, success, toolError } from "./tool-outcome.ts";

export const EditParams = Type.Object({
  path: Type.String({
    pattern: FILE_PATH_PATTERN.source,
    description:
      "Path of the file to edit, relative to the repository root or absolute inside it; it must name a file, not a directory",
  }),
  targetContent: Type.String({
    minLength: 1,
    description: "Exact text to replace; it must occur exactly once in the file",
  }),
  replacementContent: Type.String({ description: "Text that replaces the one occurrence" }),
});

type EditInput = Static<typeof EditParams>;

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
      "Replace text in an existing file atomically. targetContent must occur exactly once; " +
      "no match or more than one match fails without changing the file.",
    parameters: EditParams,
    mutation: "mutating",

    // Counts the matches and checks the target without changing anything, so an edit that cannot
    // apply fails before the Approval rather than after it.
    async prepare(input, { workspace, signal }): Promise<PrepareOutcome<typeof EditParams>> {
      const invalid = checkInput(input);
      if (invalid !== undefined) {
        return prepareFailure<typeof EditParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
      const resolved = await workspace.resolveExisting(input.path);
      if (!resolved.ok) return resolved;
      const target = await inspectTarget(writeFs, resolved.path);
      if (!target.ok) return prepareFailure<typeof EditParams>(asEditError(target.error));
      const replaced = await replaceOnce(readFs, resolved.path, input, signal);
      if (!replaced.ok) return prepareFailure<typeof EditParams>(replaced.error);
      const shown = displayPath(workspace.repoRoot, resolved.path);
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary:
            `replace ${preview(input.targetContent)} with ${preview(input.replacementContent)} ` +
            `in ${quote(shown)}`,
        },
      };
    },

    // Re-validates the prepared path and re-reads the file, since the filesystem may have changed.
    async execute(prepared, { workspace, signal }): Promise<ToolOutcome> {
      const validated = await revalidatePreparedPath(prepared.paths, (path) =>
        workspace.resolveExisting(path),
      );
      if (!validated.ok) return toolError({ code: validated.code, message: validated.message });
      const replaced = await replaceOnce(readFs, validated.path, prepared.input, signal);
      if (!replaced.ok) return toolError(replaced.error);
      const written = await replaceAtomically(writeFs, validated.path, replaced.content, {
        signal,
        createMissing: false,
      });
      if (!written.ok) return toolError(asEditError(written.error));
      return success(
        `${quote(validated.path)} (1 replacement, ${describeBytes(replaced.content)} written)`,
      );
    },
  };
}

// Schema Validation belongs to Agent Core (ADR 0001 §1); this repeats the schema's rules so
// prepare never reads with an argument the declaration forbids.
function checkInput({ path, targetContent, replacementContent }: EditInput): string | undefined {
  const invalidPath = checkFilePath(path);
  if (invalidPath !== undefined) return invalidPath;
  // An empty target matches at every offset, so it could never name one place to replace.
  if (typeof targetContent !== "string" || targetContent === "") {
    return "targetContent must be a non-empty string";
  }
  // Matching works on UTF-16 code units, so a target that is half of a surrogate pair would split
  // an emoji and the write would encode both halves as U+FFFD. Well-formed text cannot match
  // between the halves of a pair, nor end between them.
  if (!targetContent.isWellFormed()) return "targetContent must be well-formed Unicode text";
  if (typeof replacementContent !== "string") return "replacementContent must be a string";
  if (!replacementContent.isWellFormed()) {
    return "replacementContent must be well-formed Unicode text";
  }
  return undefined;
}

// Edit's contract has no PARENT_CREATION_FAILED (ADR 0001 §1): it never creates a parent, so a path
// that cannot be reached is simply not there. The message is kept because it says why.
function asEditError(error: ToolError): ToolError {
  return error.code === "PARENT_CREATION_FAILED"
    ? { code: "NOT_FOUND", message: error.message }
    : error;
}

type Replaced =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: ToolError };

// Reads the file and returns its text with the single match replaced. Both NO_MATCH and
// AMBIGUOUS_MATCH are decided here, before anything is written, which is what leaves the file
// byte-identical when an edit is refused.
async function replaceOnce(
  fs: ReadFileSystem,
  path: RepoPath,
  { targetContent, replacementContent }: EditInput,
  signal: AbortSignal,
): Promise<Replaced> {
  const current = await readTextFile(fs, path, signal, { invalidUtf8: "reject" });
  if (typeof current !== "string") return { ok: false, error: current };
  const matches = findMatches(current, targetContent);
  if (matches.count === 0) {
    return {
      ok: false,
      error: { code: "NO_MATCH", message: `targetContent does not occur in ${quote(path)}` },
    };
  }
  if (matches.count > 1) {
    return {
      ok: false,
      error: {
        code: "AMBIGUOUS_MATCH",
        message: `targetContent occurs ${matches.count} times in ${quote(path)}; add surrounding text to make it unique`,
      },
    };
  }
  return {
    ok: true,
    content:
      current.slice(0, matches.first) +
      replacementContent +
      current.slice(matches.first + targetContent.length),
  };
}

interface Matches {
  readonly count: number;
  // The offset of the first match, which is the only one when the caller accepts the edit.
  readonly first: number;
}

// Counts every placement of the target, overlapping ones included: in "aaa" the target "aa" is
// ambiguous rather than a single match, because replacing either placement would change different
// text. The caller guarantees a non-empty target, so the search always advances.
function findMatches(content: string, target: string): Matches {
  let count = 0;
  let first = -1;
  for (let at = content.indexOf(target); at !== -1; at = content.indexOf(target, at + 1)) {
    if (count === 0) first = at;
    count += 1;
  }
  return { count, first };
}
