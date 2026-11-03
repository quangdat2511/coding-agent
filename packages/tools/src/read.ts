import * as nodeFs from "node:fs/promises";
import { relative } from "node:path";
import type {
  ExecutableTool,
  PrepareOutcome,
  RepoPath,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import { quote } from "./messages.ts";
import { type ReadFileSystem, readTextFile } from "./text-file.ts";
import { prepareFailure, success, toolError } from "./tool-outcome.ts";

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
      if (invalid !== undefined) {
        return prepareFailure<typeof ReadParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
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
      if (!resolved.ok) return toolError(resolved);
      const text = await readTextFile(fs, resolved.path, signal, { invalidUtf8: "replace" });
      if (typeof text !== "string") return toolError(text);
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

function render(
  path: RepoPath,
  text: string,
  { offset = 1, limit = DEFAULT_LIMIT }: ReadInput,
): ToolOutcome {
  const all = splitLines(text);
  if (all.length === 0 && offset === 1) return success(`${quote(path)} (empty file)`);
  if (offset > all.length) {
    return toolError({
      code: "SCHEMA_VIOLATION",
      message: `offset ${offset} is past the end of ${quote(path)}, which has ${all.length} lines`,
    });
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
