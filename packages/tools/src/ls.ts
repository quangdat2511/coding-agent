import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutableTool,
  JsonValue,
  PrepareOutcome,
  RepoPath,
  ToolError,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import { errnoOf } from "./errno.ts";
import { displayPath, quote } from "./messages.ts";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "./output-budget.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { prepareFailure, success, toolError } from "./tool-outcome.ts";

const DEFAULT_LIMIT = 500;
const LINE_TRUNCATION_MARKER = TOOL_OUTPUT_TRUNCATION_MARKER.trim();

export interface LsStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface LsFileSystem {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<LsStats>;
}

export interface LsTruncationDetails {
  readonly collectedEntries: number;
  readonly outputEntries: number;
  readonly collectedBytes: number;
  readonly outputBytes: number;
}

export interface LsToolDetails {
  readonly entryLimitReached?: number;
  readonly skippedEntries?: number;
  readonly truncation?: LsTruncationDetails;
}

export const LsParams = Type.Object({
  path: Type.Optional(
    Type.String({
      description: 'Path of the directory to list, relative to the repository root (default ".")',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Maximum number of entries to return (default ${DEFAULT_LIMIT})`,
    }),
  ),
});

type LsInput = Static<typeof LsParams>;

export function lsTool(): ExecutableTool<typeof LsParams> {
  return lsToolWith(nodeFs);
}

export function lsToolWith(fs: LsFileSystem): ExecutableTool<typeof LsParams> {
  return {
    name: "ls",
    description:
      "List a directory in the repository. Returns entry names sorted case-insensitively, " +
      "directories with '/' and symbolic links with '@'. Includes dotfiles. " +
      `Output is limited to ${DEFAULT_LIMIT} entries and 40 KiB.`,
    parameters: LsParams,
    mutation: "read_only",

    async prepare(input, { workspace }): Promise<PrepareOutcome<typeof LsParams>> {
      const invalid = checkInput(input);
      if (invalid !== undefined) {
        return prepareFailure<typeof LsParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
      const resolved = await workspace.resolveExisting(input.path ?? ".");
      if (!resolved.ok) return resolved;
      const shown = displayPath(workspace.repoRoot, resolved.path);
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: `ls ${quote(shown)}`,
        },
      };
    },

    async execute(prepared, { workspace }): Promise<ToolOutcome> {
      const validated = await revalidatePreparedPath(prepared.paths, (path) =>
        workspace.resolveExisting(path),
      );
      if (!validated.ok) return toolError({ code: validated.code, message: validated.message });

      const shown = displayPath(workspace.repoRoot, validated.path);
      let names: string[];
      try {
        names = await fs.readdir(validated.path);
      } catch (error) {
        return toolError(readdirFailure(validated.path, error));
      }
      if (names.length === 0) {
        return success(`${quote(shown)} (empty directory)`);
      }

      const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const limit = prepared.input.limit ?? DEFAULT_LIMIT;
      const entryLimitReached = sorted.length > limit ? limit : undefined;
      const selected = sorted.slice(0, limit);

      const lines: string[] = [];
      let skippedEntries = 0;
      for (const name of selected) {
        let stats: LsStats;
        try {
          stats = await fs.lstat(join(validated.path, name));
        } catch {
          skippedEntries += 1;
          continue;
        }
        const suffix = stats.isSymbolicLink() ? "@" : stats.isDirectory() ? "/" : "";
        lines.push(`${escapeEntryName(name)}${suffix}`);
      }

      const limitNotice =
        entryLimitReached !== undefined
          ? `[${entryLimitReached} entries limit reached. Use limit=${entryLimitReached * 2} for more]`
          : undefined;

      if (lines.length === 0) {
        const content =
          limitNotice !== undefined
            ? `${quote(shown)} (no readable entries)\n${limitNotice}`
            : `${quote(shown)} (no readable entries)`;
        const details = buildDetails({
          entryLimitReached,
          skippedEntries: skippedEntries > 0 ? skippedEntries : undefined,
        });
        return {
          isError: false,
          content,
          ...(details !== undefined ? { details } : {}),
        };
      }

      const bounded = boundListingLines(lines, limitNotice);
      const details = buildDetails({
        entryLimitReached,
        skippedEntries: skippedEntries > 0 ? skippedEntries : undefined,
        truncation: bounded.truncation,
      });
      return {
        isError: false,
        content: bounded.content,
        ...(bounded.truncation !== undefined ? { truncated: true } : {}),
        ...(details !== undefined ? { details } : {}),
      };
    },
  };
}

function utf8Bytes(text: string): number {
  return Buffer.from(text, "utf8").byteLength;
}

function boundListingLines(
  lines: readonly string[],
  limitNotice: string | undefined,
): { readonly content: string; readonly truncation?: LsTruncationDetails } {
  const joined = lines.join("\n");
  const collectedBytes = utf8Bytes(joined);
  const full = limitNotice !== undefined ? `${joined}\n${limitNotice}` : joined;
  if (utf8Bytes(full) <= MAX_TOOL_OUTPUT_BYTES) {
    return { content: full };
  }

  const footer =
    limitNotice !== undefined
      ? `${limitNotice}. ${LINE_TRUNCATION_MARKER}`
      : LINE_TRUNCATION_MARKER;
  const lineBudget = MAX_TOOL_OUTPUT_BYTES - utf8Bytes(footer) - 1;
  const kept: string[] = [];
  let outputBytes = 0;
  for (const line of lines) {
    const lineBytes = utf8Bytes(line);
    const needed = kept.length === 0 ? lineBytes : outputBytes + 1 + lineBytes;
    if (needed > lineBudget) break;
    kept.push(line);
    outputBytes = needed;
  }

  return {
    content: kept.length === 0 ? footer : `${kept.join("\n")}\n${footer}`,
    truncation: {
      collectedEntries: lines.length,
      outputEntries: kept.length,
      collectedBytes,
      outputBytes,
    },
  };
}

function buildDetails(raw: LsToolDetails): Readonly<Record<string, JsonValue>> | undefined {
  const details: Record<string, JsonValue> = {};
  if (raw.entryLimitReached !== undefined) details.entryLimitReached = raw.entryLimitReached;
  if (raw.skippedEntries !== undefined) details.skippedEntries = raw.skippedEntries;
  if (raw.truncation !== undefined) {
    details.truncation = { ...raw.truncation };
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function checkInput({ limit }: LsInput): string | undefined {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    return `limit must be an integer of at least 1, got ${limit}`;
  }
  return undefined;
}

function escapeEntryName(name: string): string {
  return name.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function readdirFailure(path: RepoPath, error: unknown): ToolError {
  switch (errnoOf(error)) {
    case "ENOENT":
      return { code: "NOT_FOUND", message: `${quote(path)} does not exist` };
    case "ENOTDIR":
      return { code: "NOT_A_DIRECTORY", message: `${quote(path)} is not a directory` };
    case "EACCES":
    case "EPERM":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(path)} cannot be read: permission denied`,
      };
    default: {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        code: "TOOL_INTERNAL_ERROR",
        message: `${quote(path)} could not be listed: ${detail}`,
      };
    }
  }
}
