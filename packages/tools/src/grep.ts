import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs/promises";
import { posix, win32 } from "node:path";
import type {
  ExecutableTool,
  JsonValue,
  PrepareOutcome,
  RepoPath,
  ToolError,
  ToolOutcome,
} from "@coding-agent/agent-core";
import { type Static, Type } from "typebox";
import type { ChildProcessLauncher } from "./child-process.ts";
import { errnoOf } from "./errno.ts";
import type { ToolAcquirer } from "./managed-tools.ts";
import { displayPath, quote, toPortablePath } from "./messages.ts";
import { boundToolOutput, MAX_TOOL_OUTPUT_BYTES } from "./output-budget.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { type ProcessKillFn, runSupervised, type SupervisedExit } from "./process-run.ts";
import { prepareFailure, toolError } from "./tool-outcome.ts";

const DEFAULT_LIMIT = 100;
const MAX_LINE_CHARS = 500;
const NO_MATCHES_OUTPUT = "No matches found";

export interface GrepStats {
  isDirectory(): boolean;
}

export interface GrepFileSystem {
  stat(path: RepoPath): Promise<GrepStats>;
}

export interface GrepToolDetails {
  readonly matchLimitReached?: number;
  readonly linesTruncated?: boolean;
}

export interface GrepToolDeps {
  readonly launcher: ChildProcessLauncher;
  readonly acquirer: ToolAcquirer;
  readonly fs?: GrepFileSystem;
  readonly platform?: NodeJS.Platform;
  readonly killProcess?: ProcessKillFn;
}

export const GrepParams = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      description: "Regular expression to search for (ripgrep syntax)",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "File or directory to search, relative to the repository root (default: the root)",
      }),
    ),
    glob: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Search only files whose path matches this glob, e.g. src/**/*.ts; a leading ! excludes",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description: "Case-insensitive search",
      }),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description: "Treat the pattern as a literal string, not a regular expression",
      }),
    ),
    context: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Lines of context before and after each match (default 0)",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Maximum number of matches to return (default ${DEFAULT_LIMIT})`,
      }),
    ),
  },
  { additionalProperties: false },
);

type GrepInput = Static<typeof GrepParams>;

export function grepTool(
  launcher: ChildProcessLauncher,
  acquirer: ToolAcquirer,
): ExecutableTool<typeof GrepParams> {
  return grepToolWith({ launcher, acquirer });
}

export function grepToolWith(deps: GrepToolDeps): ExecutableTool<typeof GrepParams> {
  const { launcher, acquirer, killProcess } = deps;
  const fs = deps.fs ?? nodeFs;
  const platform = deps.platform ?? process.platform;

  return {
    name: "grep",
    description:
      "Search file contents with ripgrep. Returns <path>:<line>: <text> for each match and " +
      "<path>-<line>- <text> for context lines, paths relative to the repository root. " +
      "Searches hidden files and applies .gitignore rules only inside a git repository; " +
      `.git is not excluded. Output is limited to ${DEFAULT_LIMIT} matches and each line to ${MAX_LINE_CHARS} characters.`,
    parameters: GrepParams,
    mutation: "read_only",

    async prepare(input, { workspace }): Promise<PrepareOutcome<typeof GrepParams>> {
      const invalid = checkInput(input);
      if (invalid !== undefined) {
        return prepareFailure<typeof GrepParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
      const target = input.path === undefined || input.path === "" ? "." : input.path;
      const resolved = await workspace.resolveExisting(target);
      if (!resolved.ok) {
        return prepareFailure<typeof GrepParams>({
          code: resolved.code,
          message: resolved.message,
        });
      }
      const shown = displayPath(workspace.repoRoot, resolved.path, platform);
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: formatSummary(input, shown),
        },
      };
    },

    async execute(prepared, { workspace, signal }): Promise<ToolOutcome> {
      const cancelled = (): ToolOutcome =>
        toolError({ code: "SIGNAL", message: "ripgrep search cancelled" });

      if (signal.aborted) return cancelled();

      const validated = await revalidatePreparedPath(prepared.paths, (path) =>
        workspace.resolveExisting(path),
      );
      if (!validated.ok) {
        return toolError({ code: validated.code, message: validated.message });
      }
      if (signal.aborted) return cancelled();

      let isDirectory: boolean;
      try {
        isDirectory = (await fs.stat(validated.path)).isDirectory();
      } catch (error) {
        if (signal.aborted) return cancelled();
        return toolError(statFailure(validated.path, error));
      }
      if (signal.aborted) return cancelled();

      const acquired = await acquirer.acquire("rg", { signal });
      if (!acquired.ok) {
        if (acquired.reason === "cancelled" || signal.aborted) return cancelled();
        return toolError({ code: "TOOL_INTERNAL_ERROR", message: acquired.message });
      }
      if (signal.aborted) return cancelled();

      const cwd: RepoPath = isDirectory ? validated.path : workspace.repoRoot;
      const argv = buildRgArgv(acquired.path, prepared.input, isDirectory ? "." : validated.path);
      const limit = prepared.input.limit ?? DEFAULT_LIMIT;

      const outputLines: string[] = [];
      let matchCount = 0;
      let matchLimitReached: number | undefined;
      let linesTruncated = false;
      let stdoutRemainder = "";
      let stderrText = "";

      const runController = new AbortController();
      const onCallerAbort = () => runController.abort();
      signal.addEventListener("abort", onCallerAbort, { once: true });

      const handleJsonLine = (rawLine: string): void => {
        if (matchLimitReached !== undefined) return;
        const trimmed = rawLine.trim();
        if (trimmed === "") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        const event = parseRgEvent(parsed);
        if (event === undefined) return;

        if (event.type === "match") {
          if (matchCount >= limit) {
            matchLimitReached = limit;
            runController.abort();
            return;
          }
          matchCount += 1;
        }

        const formattedPath = formatResultPath(workspace.repoRoot, cwd, event.path, platform);
        const rawText = stripOneLineTerminator(event.text);
        const { text, truncated } = truncateLineText(rawText);
        if (truncated) linesTruncated = true;

        const sep = event.type === "match" ? ":" : "-";
        outputLines.push(`${formattedPath}${sep}${event.lineNumber}${sep} ${text}`);
      };

      let exit: SupervisedExit;
      try {
        exit = await runSupervised(launcher, {
          argv,
          cwd,
          signal: runController.signal,
          killProcess,
          onOutput: (_chunk, text) => {
            if (matchLimitReached !== undefined) return;
            stdoutRemainder += text;
            let newlineIndex = stdoutRemainder.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = stdoutRemainder.slice(0, newlineIndex);
              stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
              handleJsonLine(line);
              if (matchLimitReached !== undefined) {
                stdoutRemainder = "";
                return;
              }
              newlineIndex = stdoutRemainder.indexOf("\n");
            }
          },
          onStderr: (_chunk, text) => {
            if (stderrText.length < MAX_TOOL_OUTPUT_BYTES) {
              stderrText += text;
            }
          },
        });
      } catch (error) {
        if (signal.aborted) return cancelled();
        const detail = error instanceof Error ? error.message : String(error);
        return toolError({
          code: "TOOL_INTERNAL_ERROR",
          message: `Failed to launch ripgrep: ${detail}`,
        });
      } finally {
        signal.removeEventListener("abort", onCallerAbort);
      }

      if (signal.aborted) return cancelled();

      if (matchLimitReached === undefined && stdoutRemainder.length > 0) {
        handleJsonLine(stdoutRemainder);
      }

      if (matchLimitReached === undefined) {
        if (exit.signalCode !== null) {
          const trimmedStderr = stderrText.trim();
          return toolError({
            code: "SIGNAL",
            message: trimmedStderr || `ripgrep terminated by ${exit.signalCode}`,
          });
        }
        if (exit.exitCode !== 0 && exit.exitCode !== 1) {
          const trimmedStderr = stderrText.trim();
          const code = exit.exitCode ?? 1;
          return toolError({
            code: "NON_ZERO_EXIT",
            message: trimmedStderr || `ripgrep exited with code ${code}`,
          });
        }
      }

      if (outputLines.length === 0) {
        return { isError: false, content: NO_MATCHES_OUTPUT };
      }

      const notices: string[] = [];
      if (matchLimitReached !== undefined) {
        notices.push(
          `${matchLimitReached} matches limit reached. Use limit=${matchLimitReached * 2} for more, or refine pattern`,
        );
      }
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${MAX_LINE_CHARS} chars. Use read tool to see full lines`,
        );
      }

      const body = outputLines.join("\n");
      const rawContent = notices.length > 0 ? `${body}\n\n[${notices.join(". ")}]` : body;
      const bounded = boundToolOutput(rawContent);
      const details = buildDetails({
        matchLimitReached,
        linesTruncated: linesTruncated ? true : undefined,
      });

      return {
        isError: false,
        content: bounded.content,
        ...(bounded.truncated ? { truncated: true } : {}),
        ...(details !== undefined ? { details } : {}),
      };
    },
  };
}

interface RgEvent {
  readonly type: "match" | "context";
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
}

function parseRgEvent(value: unknown): RgEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== "match" && type !== "context") return undefined;
  const data = record.data;
  if (typeof data !== "object" || data === null) return undefined;
  const dataRecord = data as Record<string, unknown>;
  const path = decodeRgText(dataRecord.path);
  const text = decodeRgText(dataRecord.lines);
  const lineNumber = dataRecord.line_number;
  if (
    path === undefined ||
    text === undefined ||
    typeof lineNumber !== "number" ||
    !Number.isFinite(lineNumber)
  ) {
    return undefined;
  }
  return { type, path, lineNumber, text };
}

function decodeRgText(field: unknown): string | undefined {
  if (typeof field !== "object" || field === null) return undefined;
  const record = field as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.bytes === "string") {
    return Buffer.from(record.bytes, "base64").toString("utf8");
  }
  return undefined;
}

function buildRgArgv(binaryPath: string, input: GrepInput, target: string): string[] {
  const argv = [binaryPath, "--no-config", "--json", "--line-number", "--color=never", "--hidden"];
  if (input.ignoreCase) argv.push("--ignore-case");
  if (input.literal) argv.push("--fixed-strings");
  if (input.glob !== undefined) argv.push(`--glob=${input.glob}`);
  if (input.context !== undefined && input.context >= 1) {
    const clamped = Math.min(input.context, Number.MAX_SAFE_INTEGER);
    argv.push(`--context=${String(clamped)}`);
  }
  argv.push("--", input.pattern, target);
  return argv;
}

function formatResultPath(
  repoRoot: RepoPath,
  cwd: RepoPath,
  rawPath: string,
  platform: NodeJS.Platform,
): string {
  const pathLib = platform === "win32" ? win32 : posix;
  const absolute = pathLib.resolve(cwd, rawPath);
  const relative = pathLib.relative(repoRoot, absolute);
  const portable = toPortablePath(relative, platform);
  return portable.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function stripOneLineTerminator(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function truncateLineText(text: string): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= MAX_LINE_CHARS) return { text, truncated: false };
  let end = MAX_LINE_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    const next = text.charCodeAt(end);
    if (next >= 0xdc00 && next <= 0xdfff) {
      end -= 1;
    }
  }
  return { text: `${text.slice(0, end)}... [truncated]`, truncated: true };
}

function buildDetails(raw: GrepToolDetails): Readonly<Record<string, JsonValue>> | undefined {
  const details: Record<string, JsonValue> = {};
  if (raw.matchLimitReached !== undefined) details.matchLimitReached = raw.matchLimitReached;
  if (raw.linesTruncated !== undefined) details.linesTruncated = raw.linesTruncated;
  return Object.keys(details).length > 0 ? details : undefined;
}

const ALLOWED_KEYS = new Set([
  "pattern",
  "path",
  "glob",
  "ignoreCase",
  "literal",
  "context",
  "limit",
]);

function checkInput(input: GrepInput): string | undefined {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      return `unexpected parameter ${quote(key)}`;
    }
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return "pattern must be non-empty text";
  }
  if (input.glob !== undefined && (typeof input.glob !== "string" || input.glob.length === 0)) {
    return "glob must be non-empty text";
  }
  if (input.context !== undefined && !(Number.isInteger(input.context) && input.context >= 0)) {
    return `context must be an integer of at least 0, got ${input.context}`;
  }
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1)) {
    return `limit must be an integer of at least 1, got ${input.limit}`;
  }
  return undefined;
}

function formatSummary(input: GrepInput, shownPath: string): string {
  const parts = [`grep ${quote(input.pattern)} in ${shownPath}`];
  if (input.limit !== undefined && input.limit !== DEFAULT_LIMIT) {
    parts.push(`limit ${input.limit}`);
  }
  if (input.glob !== undefined) {
    parts.push(`glob ${input.glob}`);
  }
  return parts.join(" ");
}

function statFailure(path: RepoPath, error: unknown): ToolError {
  switch (errnoOf(error)) {
    case "ENOENT":
      return { code: "NOT_FOUND", message: `${quote(path)} does not exist` };
    case "EACCES":
    case "EPERM":
      return {
        code: "PERMISSION_DENIED",
        message: `${quote(path)} cannot be read: permission denied`,
      };
    default:
      return {
        code: "TOOL_INTERNAL_ERROR",
        message: `Could not inspect ${quote(path)}`,
      };
  }
}
