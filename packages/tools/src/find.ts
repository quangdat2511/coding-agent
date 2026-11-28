import { Buffer } from "node:buffer";
import { constants } from "node:fs";
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
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "./output-budget.ts";
import { revalidatePreparedPath } from "./prepared-path.ts";
import { type ProcessKillFn, runSupervised, type SupervisedExit } from "./process-run.ts";
import { prepareFailure, toolError } from "./tool-outcome.ts";

const DEFAULT_LIMIT = 1000;
const MIN_FD_VERSION = "10.5.1";
const LINE_TRUNCATION_MARKER = TOOL_OUTPUT_TRUNCATION_MARKER.trim();

export interface FindStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FindFileSystem {
  stat(path: string): Promise<FindStats>;
  lstat(path: string): Promise<FindStats>;
  access(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface FindRunRequest {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: RepoPath;
  readonly signal: AbortSignal;
}

export interface FindRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly cancelled?: boolean;
}

export interface FindOperations {
  run(request: FindRunRequest): Promise<FindRunResult>;
}

export interface FindTruncationDetails {
  readonly collectedResults: number;
  readonly outputResults: number;
  readonly collectedBytes: number;
  readonly outputBytes: number;
}

export interface FindIncompleteDetails {
  readonly exitCode: number;
}

export interface FindToolDetails {
  readonly resultLimitReached?: number;
  readonly truncation?: FindTruncationDetails;
  readonly incomplete?: FindIncompleteDetails;
}

export interface FindToolDeps {
  readonly acquirer: ToolAcquirer;
  readonly launcher?: ChildProcessLauncher;
  readonly ops?: FindOperations;
  readonly fs?: FindFileSystem;
  readonly platform?: NodeJS.Platform;
  readonly killProcess?: ProcessKillFn;
}

export const FindParams = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      description:
        "Glob pattern relative to the search directory, e.g. 'src/**/*.ts'. " +
        "Without '/', e.g. '*.ts', it matches names at any depth",
    }),
    path: Type.Optional(
      Type.String({
        description: 'Directory to search in, relative to the repository root (default ".")',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Maximum number of results to return (default ${DEFAULT_LIMIT})`,
      }),
    ),
  },
  { additionalProperties: false },
);

type FindInput = Static<typeof FindParams>;

const defaultFs: FindFileSystem = {
  stat: (path) => nodeFs.stat(path),
  lstat: (path) => nodeFs.lstat(path),
  access: (path, mode) => nodeFs.access(path, mode),
  async exists(path) {
    try {
      await nodeFs.lstat(path);
      return true;
    } catch {
      return false;
    }
  },
};

export function createFindOperations(
  launcher: ChildProcessLauncher,
  killProcess?: ProcessKillFn,
): FindOperations {
  return {
    async run(request) {
      let stdout = "";
      let stderr = "";
      const exit: SupervisedExit = await runSupervised(launcher, {
        argv: [request.binary, ...request.args],
        cwd: request.cwd,
        signal: request.signal,
        killProcess,
        onOutput: (_chunk, text) => {
          stdout += text;
        },
        onStderr: (_chunk, text) => {
          if (stderr.length < MAX_TOOL_OUTPUT_BYTES) {
            stderr += text;
          }
        },
      });
      return {
        stdout,
        stderr,
        exitCode: exit.exitCode,
        signalCode: exit.signalCode,
        cancelled: exit.stopReason === "cancelled",
      };
    },
  };
}

export function findTool(
  launcher: ChildProcessLauncher,
  acquirer: ToolAcquirer,
): ExecutableTool<typeof FindParams> {
  return findToolWith({ launcher, acquirer });
}

export function findToolWith(deps: FindToolDeps): ExecutableTool<typeof FindParams> {
  const { acquirer } = deps;
  const ops =
    deps.ops ?? (deps.launcher ? createFindOperations(deps.launcher, deps.killProcess) : undefined);
  if (ops === undefined) {
    throw new Error("findToolWith requires either launcher or ops");
  }
  const fs = deps.fs ?? defaultFs;
  const platform = deps.platform ?? process.platform;

  return {
    name: "find",
    description:
      "Find paths by glob pattern in the repository. Returns repository-relative paths in fd's " +
      "traversal order; a directory ends with '/'. Respects .gitignore. Without '/', the pattern " +
      `matches names at any depth; with '/', it is relative to path. Output is limited to ${DEFAULT_LIMIT} ` +
      "results and 40 KiB.",
    parameters: FindParams,
    mutation: "read_only",

    async prepare(input, { workspace }): Promise<PrepareOutcome<typeof FindParams>> {
      const invalid = checkInput(input);
      if (invalid !== undefined) {
        return prepareFailure<typeof FindParams>({ code: "SCHEMA_VIOLATION", message: invalid });
      }
      const target = input.path === undefined || input.path === "" ? "." : input.path;
      const resolved = await workspace.resolveExisting(target);
      if (!resolved.ok) {
        return prepareFailure<typeof FindParams>(resolutionError(resolved));
      }
      const shown = displayPath(workspace.repoRoot, resolved.path, platform);
      return {
        ok: true,
        prepared: {
          input,
          paths: [resolved.path],
          summary: `find ${quote(input.pattern)} in ${quote(shown)}`,
        },
      };
    },

    async execute(prepared, { workspace, signal }): Promise<ToolOutcome> {
      const cancelled = (): ToolOutcome =>
        toolError({ code: "SIGNAL", message: "fd search cancelled" });

      if (signal.aborted) return cancelled();

      const validated = await revalidatePreparedPath(prepared.paths, (path) =>
        workspace.resolveExisting(path),
      );
      if (!validated.ok) {
        return toolError(resolutionError(validated));
      }
      if (signal.aborted) return cancelled();

      const dirError = await checkSearchDirectory(validated.path, fs);
      if (dirError !== undefined) {
        if (signal.aborted) return cancelled();
        return toolError(dirError);
      }
      if (signal.aborted) return cancelled();

      const acquired = await acquirer.acquire("fd", { signal });
      if (!acquired.ok) {
        if (acquired.reason === "cancelled" || signal.aborted) return cancelled();
        return toolError({ code: "TOOL_INTERNAL_ERROR", message: acquired.message });
      }
      if (signal.aborted) return cancelled();

      if (!meetsVersionFloor(acquired.version, MIN_FD_VERSION)) {
        return toolError({
          code: "TOOL_INTERNAL_ERROR",
          message: `fd ${acquired.version} is older than the minimum supported version ${MIN_FD_VERSION}`,
        });
      }

      const limit = prepared.input.limit ?? DEFAULT_LIMIT;
      const noRequireGit = !(await hasGitAncestor(validated.path, fs, platform));
      if (signal.aborted) return cancelled();

      const args = buildFdArgs({
        pattern: prepared.input.pattern,
        searchRoot: validated.path,
        limit,
        noRequireGit,
        platform,
      });

      let runResult: FindRunResult;
      try {
        runResult = await ops.run({
          binary: acquired.path,
          args,
          cwd: workspace.repoRoot,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return cancelled();
        const detail = error instanceof Error ? error.message : String(error);
        return toolError({
          code: "TOOL_INTERNAL_ERROR",
          message: `Failed to launch fd: ${detail}`,
        });
      }

      if (signal.aborted || runResult.cancelled) return cancelled();

      const rawLines = splitFdLines(runResult.stdout, platform);
      const shown = displayPath(workspace.repoRoot, validated.path, platform);
      const exitedNonZero =
        (runResult.exitCode !== null && runResult.exitCode !== 0) ||
        (runResult.exitCode === null &&
          runResult.signalCode !== null &&
          runResult.signalCode !== undefined);

      if (rawLines.length === 0) {
        if (exitedNonZero) {
          const trimmedStderr = runResult.stderr.trim();
          const message =
            trimmedStderr !== ""
              ? trimmedStderr
              : runResult.exitCode !== null
                ? `fd exited with code ${runResult.exitCode}`
                : `fd terminated by ${runResult.signalCode}`;
          return toolError({ code: "NON_ZERO_EXIT", message });
        }
        return formatOutcome(
          boundFindLines(
            [`No paths matching ${quote(prepared.input.pattern)} in ${quote(shown)}`],
            [],
            0,
          ),
          undefined,
          undefined,
        );
      }

      const resultLimitReached = rawLines.length > limit ? limit : undefined;
      const selected = rawLines.slice(0, limit);
      const formattedLines = await formatResultLines(
        selected,
        workspace.repoRoot,
        fs,
        platform,
        signal,
      );
      if (signal.aborted) return cancelled();

      const incomplete: FindIncompleteDetails | undefined = exitedNonZero
        ? { exitCode: runResult.exitCode ?? 1 }
        : undefined;

      const notices: string[] = [];
      if (resultLimitReached !== undefined) {
        notices.push(
          `[${resultLimitReached} results limit reached. Use limit=${resultLimitReached * 2} for more, or refine pattern]`,
        );
      }
      if (incomplete !== undefined) {
        notices.push("[... results may be incomplete]");
      }

      const bounded = boundFindLines(formattedLines, notices, formattedLines.length);
      return formatOutcome(bounded, resultLimitReached, incomplete);
    },
  };
}

interface BuildFdArgsOptions {
  readonly pattern: string;
  readonly searchRoot: RepoPath;
  readonly limit: number;
  readonly noRequireGit: boolean;
  readonly platform: NodeJS.Platform;
}

function buildFdArgs(options: BuildFdArgsOptions): string[] {
  const { searchRoot, limit, noRequireGit, platform } = options;
  const normalized = platform === "win32" ? options.pattern.replaceAll("\\", "/") : options.pattern;
  const stripped = normalized.replace(/^(?:\.\/)+/, "");
  const effectivePattern = stripped.length > 0 ? stripped : normalized;
  const hasSlash = effectivePattern.includes("/");

  let fullPath = false;
  let ignoreCase = false;
  let fdPattern = effectivePattern;

  if (hasSlash) {
    fullPath = true;
    if (!isAbsolutePattern(effectivePattern, platform)) {
      const portableRoot = toPortablePath(searchRoot, platform);
      const trimmedRoot = portableRoot.length > 1 ? portableRoot.replace(/\/+$/, "") : portableRoot;
      const escapedRoot = escapeGlobPrefix(trimmedRoot);
      fdPattern =
        trimmedRoot === "/" ? `/${effectivePattern}` : `${escapedRoot}/${effectivePattern}`;
      if (!hasUppercase(effectivePattern)) {
        ignoreCase = true;
      }
    }
  }

  const args: string[] = [
    "--color=never",
    "--hidden",
    "--glob",
    "--max-results",
    String(limit + 1),
  ];
  if (fullPath) args.push("--full-path");
  if (ignoreCase) args.push("--ignore-case");
  if (noRequireGit) args.push("--no-require-git");
  args.push("--", fdPattern, searchRoot);
  return args;
}

function isAbsolutePattern(pattern: string, platform: NodeJS.Platform): boolean {
  if (pattern.startsWith("/")) return true;
  if (platform === "win32" && /^[A-Za-z]:\//.test(pattern)) return true;
  return false;
}

function escapeGlobPrefix(prefix: string): string {
  return prefix.replace(/[\\*?[\]{}]/g, "\\$&");
}

function hasUppercase(text: string): boolean {
  return text !== text.toLowerCase();
}

async function hasGitAncestor(
  searchRoot: RepoPath,
  fs: FindFileSystem,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const pathLib = platform === "win32" ? win32 : posix;
  let current: string = searchRoot;
  for (;;) {
    if (await fs.exists(pathLib.join(current, ".git"))) return true;
    const parent = pathLib.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function resolutionError(resolved: {
  readonly code: "NOT_FOUND" | "PATH_OUTSIDE_REPO" | "PERMISSION_DENIED";
  readonly reason?: "not_a_directory";
  readonly message: string;
}): ToolError {
  return {
    code:
      resolved.code === "NOT_FOUND" && resolved.reason === "not_a_directory"
        ? "NOT_A_DIRECTORY"
        : resolved.code,
    message: resolved.message,
  };
}

function splitFdLines(stdout: string, platform: NodeJS.Platform): string[] {
  if (stdout.length === 0) return [];
  const raw = stdout.split("\n");
  const lines: string[] = [];
  for (const entry of raw) {
    const line = platform === "win32" && entry.endsWith("\r") ? entry.slice(0, -1) : entry;
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

async function formatResultLines(
  rawLines: readonly string[],
  repoRoot: RepoPath,
  fs: FindFileSystem,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<string[]> {
  const pathLib = platform === "win32" ? win32 : posix;
  const formatted: string[] = [];
  for (const rawLine of rawLines) {
    if (signal.aborted) break;
    const hadTrailingSep =
      rawLine.endsWith("/") || (platform === "win32" && rawLine.endsWith("\\"));
    const stripped = hadTrailingSep
      ? platform === "win32"
        ? rawLine.replace(/[\\/]+$/, "")
        : rawLine.replace(/\/+$/, "")
      : rawLine;
    const absPath = pathLib.isAbsolute(stripped) ? stripped : pathLib.resolve(repoRoot, stripped);
    const rel = toPortablePath(pathLib.relative(repoRoot, absPath), platform) || ".";

    let isDirectory = hadTrailingSep;
    try {
      const stats = await fs.lstat(absPath);
      isDirectory = !stats.isSymbolicLink() && stats.isDirectory();
    } catch {
      // Fall back to whether fd printed a trailing separator when lstat is unavailable.
    }

    const escaped = escapePathLine(rel);
    formatted.push(isDirectory ? `${escaped}/` : escaped);
  }
  return formatted;
}

function escapePathLine(path: string): string {
  return path.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

interface BoundedFindOutput {
  readonly content: string;
  readonly truncation?: FindTruncationDetails;
}

function utf8Bytes(text: string): number {
  return Buffer.from(text, "utf8").byteLength;
}

function boundFindLines(
  lines: readonly string[],
  notices: readonly string[],
  collectedResults: number,
): BoundedFindOutput {
  const joined = lines.join("\n");
  const collectedBytes = utf8Bytes(joined);
  const preNotice = notices.length > 0 ? notices.join(". ") : undefined;
  const full = preNotice !== undefined ? `${joined}\n${preNotice}` : joined;
  if (utf8Bytes(full) <= MAX_TOOL_OUTPUT_BYTES) {
    return { content: full };
  }

  const footer =
    preNotice !== undefined ? `${preNotice}. ${LINE_TRUNCATION_MARKER}` : LINE_TRUNCATION_MARKER;
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
      collectedResults,
      outputResults: kept.length,
      collectedBytes,
      outputBytes,
    },
  };
}

function formatOutcome(
  bounded: BoundedFindOutput,
  resultLimitReached: number | undefined,
  incomplete: FindIncompleteDetails | undefined,
): ToolOutcome {
  const details = buildDetails({
    resultLimitReached,
    truncation: bounded.truncation,
    incomplete,
  });
  return {
    isError: false,
    content: bounded.content,
    ...(bounded.truncation !== undefined ? { truncated: true } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function buildDetails(raw: FindToolDetails): Readonly<Record<string, JsonValue>> | undefined {
  const details: Record<string, JsonValue> = {};
  if (raw.resultLimitReached !== undefined) details.resultLimitReached = raw.resultLimitReached;
  if (raw.truncation !== undefined) details.truncation = { ...raw.truncation };
  if (raw.incomplete !== undefined) details.incomplete = { ...raw.incomplete };
  return Object.keys(details).length > 0 ? details : undefined;
}

const ALLOWED_KEYS = new Set(["pattern", "path", "limit"]);

function checkInput(input: FindInput): string | undefined {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      return `unexpected parameter ${quote(key)}`;
    }
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return "pattern must be a non-empty string";
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return "path must be a string";
  }
  const { limit } = input;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    return `limit must be an integer of at least 1, got ${limit}`;
  }
  return undefined;
}

async function checkSearchDirectory(
  path: RepoPath,
  fs: FindFileSystem,
): Promise<ToolError | undefined> {
  let stats: FindStats;
  try {
    stats = await fs.stat(path);
  } catch (error) {
    return directoryFailure(path, error);
  }
  if (!stats.isDirectory()) {
    return { code: "NOT_A_DIRECTORY", message: `${quote(path)} is not a directory` };
  }
  try {
    await fs.access(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    return directoryFailure(path, error);
  }
  return undefined;
}

function directoryFailure(path: RepoPath, error: unknown): ToolError {
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
    default:
      return {
        code: "TOOL_INTERNAL_ERROR",
        message: `Could not search directory ${quote(path)}`,
      };
  }
}

function meetsVersionFloor(version: string, floor: string): boolean {
  const actual = parseSemver(version);
  const minimum = parseSemver(floor);
  if (actual === undefined || minimum === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = actual[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function parseSemver(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
