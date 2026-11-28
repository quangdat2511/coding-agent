import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExecutableTool,
  ExecuteContext,
  PathResolution,
  PrepareOutcome,
  RepoPath,
  ToolOutcome,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { Value } from "typebox/value";
import type {
  ChildLaunchOptions,
  ChildProcess,
  ChildProcessLauncher,
} from "../src/child-process.ts";
import { type GrepFileSystem, GrepParams, grepTool, grepToolWith } from "../src/grep.ts";
import {
  createChildProcessLauncher,
  createToolAcquirer,
  createWorkspaceResolver,
} from "../src/index.ts";
import type { ToolAcquirer } from "../src/managed-tools.ts";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";
import { noRipgrep } from "./platform.ts";

const REPO = resolve("/fake/repo") as RepoPath;

function fakeWorkspace(
  resolvePath: (input: string) => PathResolution = (input) => ({
    ok: true,
    path: (input === "." || input === REPO
      ? REPO
      : input.startsWith(REPO)
        ? input
        : join(REPO, input)) as RepoPath,
  }),
): WorkspaceResolver {
  return {
    repoRoot: REPO,
    resolveExisting: async (input) => resolvePath(input),
    resolveForCreate: async (input) => resolvePath(input),
  };
}

function fakeAcquirer(path = "/fake/bin/rg"): ToolAcquirer {
  return {
    async acquire() {
      return { ok: true, path, version: "16.0.0" };
    },
  };
}

function unusedLauncher(): ChildProcessLauncher {
  return {
    launch() {
      throw new Error("launcher should not be called");
    },
  };
}

function fakeFs(directories: ReadonlySet<string> = new Set([REPO])): GrepFileSystem {
  return {
    async stat(path) {
      return { isDirectory: () => directories.has(path) };
    },
  };
}

function makeContext(workspace: WorkspaceResolver = fakeWorkspace()): ExecuteContext {
  return { workspace, signal: new AbortController().signal, onProgress: () => undefined };
}

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

async function prepare(
  input: GrepInput,
  tool: ExecutableTool<typeof GrepParams>,
  workspace?: WorkspaceResolver,
): Promise<PrepareOutcome<typeof GrepParams>> {
  return tool.prepare(input, makeContext(workspace));
}

describe("the grep tool's declaration", () => {
  it("is named grep, classified read-only, and declares Pi's seven parameters with no schema defaults", () => {
    const tool = grepTool(unusedLauncher(), fakeAcquirer());

    expect(tool.name).toBe("grep");
    expect(tool.mutation).toBe("read_only");
    expect(tool.description).toBe(
      "Search file contents with ripgrep. Returns <path>:<line>: <text> for each match and " +
        "<path>-<line>- <text> for context lines, paths relative to the repository root. " +
        "Searches hidden files and applies .gitignore rules only inside a git repository; " +
        ".git is not excluded. Output is limited to 100 matches and each line to 500 characters.",
    );
    expect(tool.parameters).toBe(GrepParams);

    for (const prop of Object.values(GrepParams.properties)) {
      expect("default" in prop).toBe(false);
    }

    expect(Value.Check(GrepParams, { pattern: "needle" })).toBe(true);
    expect(
      Value.Check(GrepParams, {
        pattern: "needle",
        path: "src",
        glob: "*.ts",
        ignoreCase: true,
        literal: true,
        context: 0,
        limit: 1,
      }),
    ).toBe(true);
    expect(Value.Check(GrepParams, { pattern: "" })).toBe(false);
    expect(Value.Check(GrepParams, { pattern: "x", glob: "" })).toBe(false);
    expect(Value.Check(GrepParams, { pattern: "x", context: -1 })).toBe(false);
    expect(Value.Check(GrepParams, { pattern: "x", context: 1.5 })).toBe(false);
    expect(Value.Check(GrepParams, { pattern: "x", limit: 0 })).toBe(false);
    expect(Value.Check(GrepParams, { pattern: "x", limit: 1.5 })).toBe(false);
    expect(Value.Check(GrepParams, { pattern: "x", extra: true })).toBe(false);
  });
});

describe("preparing grep", () => {
  it("defaults missing or empty path to '.' and formats the summary", async () => {
    const tool = grepToolWith({
      launcher: unusedLauncher(),
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
    });

    const fromMissing = await prepare({ pattern: "foo/bar" }, tool);
    expect(fromMissing).toEqual({
      ok: true,
      prepared: {
        input: { pattern: "foo/bar" },
        paths: [REPO],
        summary: 'grep "foo/bar" in .',
      },
    });

    const fromEmpty = await prepare({ pattern: "needle", path: "" }, tool);
    expect(fromEmpty).toEqual({
      ok: true,
      prepared: {
        input: { pattern: "needle", path: "" },
        paths: [REPO],
        summary: 'grep "needle" in .',
      },
    });
  });

  it("adds limit and glob to the summary only when non-default", async () => {
    const tool = grepToolWith({
      launcher: unusedLauncher(),
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
    });

    const defaultLimit = await prepare({ pattern: "needle", path: "src", limit: 100 }, tool);
    expect(defaultLimit.ok && defaultLimit.prepared.summary).toBe('grep "needle" in src');

    const withBoth = await prepare(
      { pattern: "needle", path: "src/a.ts", limit: 25, glob: "*.ts" },
      tool,
    );
    expect(withBoth.ok && withBoth.prepared.summary).toBe(
      'grep "needle" in src/a.ts limit 25 glob *.ts',
    );
  });

  it("repeats schema checks in prepare and refuses invalid inputs with SCHEMA_VIOLATION", async () => {
    const tool = grepToolWith({
      launcher: unusedLauncher(),
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
    });

    const cases: unknown[] = [
      { pattern: "" },
      { pattern: "x", glob: "" },
      { pattern: "x", context: -1 },
      { pattern: "x", context: 1.5 },
      { pattern: "x", limit: 0 },
      { pattern: "x", limit: -2 },
      { pattern: "x", limit: 2.5 },
      { pattern: "x", unknownKey: 1 },
    ];

    for (const bad of cases) {
      const outcome = await prepare(bad as GrepInput, tool);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("SCHEMA_VIOLATION");
    }
  });

  it("forwards workspace path resolution failures (NOT_FOUND, PATH_OUTSIDE_REPO, PERMISSION_DENIED)", async () => {
    const tool = grepToolWith({
      launcher: unusedLauncher(),
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
    });

    for (const code of ["NOT_FOUND", "PATH_OUTSIDE_REPO", "PERMISSION_DENIED"] as const) {
      const ws = fakeWorkspace(() => ({ ok: false, code, message: `failed with ${code}` }));
      const outcome = await prepare({ pattern: "needle", path: "bad" }, tool, ws);
      expect(outcome).toEqual({ ok: false, code, message: `failed with ${code}` });
    }
  });
});

interface RecordedLaunch {
  readonly command: readonly string[];
  readonly options?: ChildLaunchOptions;
}

interface FakeProcessSpec {
  readonly stdoutChunks?: readonly string[];
  readonly stderrChunks?: readonly string[];
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly stayOpenUntilKilled?: boolean;
  readonly onKill?: (signal?: NodeJS.Signals) => void;
}

function createFakeLauncher(spec: FakeProcessSpec): {
  readonly launcher: ChildProcessLauncher;
  readonly launches: RecordedLaunch[];
  readonly killSignals: Array<NodeJS.Signals | undefined>;
} {
  const launches: RecordedLaunch[] = [];
  const killSignals: Array<NodeJS.Signals | undefined> = [];
  const encoder = new TextEncoder();

  const launcher: ChildProcessLauncher = {
    launch(command, options) {
      launches.push({ command: [...command], options });
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((res) => {
        resolveExit = res;
      });
      let exitCode: number | null = null;
      let signalCode: NodeJS.Signals | null = null;
      let killed = false;

      let closeStdout!: () => void;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of spec.stdoutChunks ?? []) {
            controller.enqueue(encoder.encode(chunk));
          }
          closeStdout = () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          };
          if (!spec.stayOpenUntilKilled) {
            closeStdout();
          }
        },
      });

      let closeStderr!: () => void;
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of spec.stderrChunks ?? []) {
            controller.enqueue(encoder.encode(chunk));
          }
          closeStderr = () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          };
          if (!spec.stayOpenUntilKilled) {
            closeStderr();
          }
        },
      });

      const finish = (code: number | null, sig: NodeJS.Signals | null) => {
        if (killed) return;
        killed = true;
        exitCode = code;
        signalCode = sig;
        closeStdout();
        closeStderr();
        resolveExit(code ?? 0);
      };

      if (!spec.stayOpenUntilKilled) {
        queueMicrotask(() => finish(spec.exitCode ?? 0, spec.signalCode ?? null));
      }

      const child = {
        pid: 99999,
        stdout,
        stderr,
        exited,
        get exitCode() {
          return exitCode;
        },
        get signalCode() {
          return signalCode;
        },
        kill(sig?: NodeJS.Signals | number) {
          const sigName = typeof sig === "string" ? sig : undefined;
          killSignals.push(sigName);
          spec.onKill?.(sigName);
          finish(null, sigName ?? "SIGTERM");
        },
      };
      return child as unknown as ChildProcess;
    },
  };

  return { launcher, launches, killSignals };
}

function rgMatch(path: string, lineNumber: number, lineText: string): string {
  return `${JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: lineText },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  })}\n`;
}

function rgContext(path: string, lineNumber: number, lineText: string): string {
  return `${JSON.stringify({
    type: "context",
    data: {
      path: { text: path },
      lines: { text: lineText },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  })}\n`;
}

function rgMatchBytes(pathBytes: Buffer, lineNumber: number, lineBytes: Buffer): string {
  return `${JSON.stringify({
    type: "match",
    data: {
      path: { bytes: pathBytes.toString("base64") },
      lines: { bytes: lineBytes.toString("base64") },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  })}\n`;
}

async function runGrep(
  input: GrepInput,
  tool: ExecutableTool<typeof GrepParams>,
  options: { workspace?: WorkspaceResolver; signal?: AbortSignal } = {},
): Promise<ToolOutcome> {
  const ctx: ExecuteContext = {
    workspace: options.workspace ?? fakeWorkspace(),
    signal: options.signal ?? new AbortController().signal,
    onProgress: () => undefined,
  };
  const prepared = await tool.prepare(input, ctx);
  if (!prepared.ok) {
    return {
      isError: true,
      content: prepared.message,
      error: { code: prepared.code, message: prepared.message },
    };
  }
  return tool.execute(prepared.prepared, ctx);
}

describe("executing grep with recorded rg --json streams", () => {
  it("invokes rg with the contracted flags for a directory search and formats matches and context", async () => {
    const stdout = [
      `${JSON.stringify({ type: "begin", data: { path: { text: "./a.ts" } } })}\n`,
      rgMatch("./a.ts", 12, "const x = 1;\n"),
      rgContext("./a.ts", 13, "// context line\n"),
      "not json at all\n",
      "\n",
      rgMatch("./sub/b.ts", 4, "needle\r\n"),
      `${JSON.stringify({ type: "end", data: {} })}\n`,
    ];
    const { launcher, launches } = createFakeLauncher({ stdoutChunks: stdout });
    const srcDir = join(REPO, "src");
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer("/opt/rg"),
      fs: fakeFs(new Set([REPO, srcDir])),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep(
      {
        pattern: "-flag",
        path: "src",
        glob: "!*.test.ts",
        ignoreCase: true,
        literal: true,
        context: 1,
      },
      tool,
    );

    expect(launches).toHaveLength(1);
    expect(launches[0]?.command).toEqual([
      "/opt/rg",
      "--no-config",
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--ignore-case",
      "--fixed-strings",
      "--glob=!*.test.ts",
      "--context=1",
      "--",
      "-flag",
      ".",
    ]);
    expect(launches[0]?.options?.cwd).toBe(srcDir);

    expect(outcome).toEqual({
      isError: false,
      content: [
        "src/a.ts:12: const x = 1;",
        "src/a.ts-13- // context line",
        "src/sub/b.ts:4: needle",
      ].join("\n"),
    });
  });

  it("runs single-file search with cwd=repoRoot and absolute file path, omitting --context when 0", async () => {
    const filePath = join(REPO, "src", "only.ts");
    const { launcher, launches } = createFakeLauncher({
      stdoutChunks: [rgMatch(filePath, 7, "hello\n")],
    });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer("/opt/rg"),
      fs: fakeFs(new Set([REPO])),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep({ pattern: "hello", path: "src/only.ts", context: 0 }, tool);

    expect(launches[0]?.command).toEqual([
      "/opt/rg",
      "--no-config",
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--",
      "hello",
      filePath,
    ]);
    expect(launches[0]?.options?.cwd).toBe(REPO);
    expect(outcome).toEqual({
      isError: false,
      content: "src/only.ts:7: hello",
    });
  });

  it("returns 'No matches found' with no details on exit 1 or empty output", async () => {
    const { launcher } = createFakeLauncher({ stdoutChunks: [], exitCode: 1 });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep({ pattern: "nothing" }, tool);
    expect(outcome).toEqual({ isError: false, content: "No matches found" });
  });

  it("handles chunked JSON lines, base64 bytes, lone CR, colons and newlines in paths", async () => {
    const line1 = rgMatch("dir:one/a.ts", 1, "keep\rmid\r\n");
    const line2 = rgMatch("weird\nname\r.ts", 2, "bare\r");
    const line3 = rgMatchBytes(Buffer.from("bin/file.txt", "utf8"), 3, Buffer.from("ok\n", "utf8"));
    const combined = line1 + line2 + line3;
    const mid = Math.floor(combined.length / 2);

    const { launcher } = createFakeLauncher({
      stdoutChunks: [combined.slice(0, mid), combined.slice(mid)],
    });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep({ pattern: "x" }, tool);
    expect(outcome).toEqual({
      isError: false,
      content: [
        "dir:one/a.ts:1: keep\rmid",
        "weird\\nname\\r.ts:2: bare\r",
        "bin/file.txt:3: ok",
      ].join("\n"),
    });
  });

  it("normalizes Windows path separators to '/' in output", async () => {
    const winRepo = "C:\\repo" as RepoPath;
    const winSrc = "C:\\repo\\src" as RepoPath;
    const ws: WorkspaceResolver = {
      repoRoot: winRepo,
      resolveExisting: async (p) => ({
        ok: true,
        path: p === "src" || p === winSrc ? winSrc : winRepo,
      }),
      resolveForCreate: async () => ({ ok: true, path: winRepo }),
    };
    const { launcher } = createFakeLauncher({
      stdoutChunks: [rgMatch(".\\nested\\file.ts", 5, "hit\n")],
    });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(new Set([winRepo, winSrc])),
      platform: "win32",
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep({ pattern: "hit", path: "src" }, tool, { workspace: ws });
    expect(outcome).toEqual({
      isError: false,
      content: "src/nested/file.ts:5: hit",
    });
  });

  it("does not report matchLimitReached for exactly limit matches, but caps and kills on limit + 1 while keeping Nth trailing context", async () => {
    const exactStream = [
      rgMatch("a.ts", 1, "m1\n"),
      rgMatch("a.ts", 2, "m2\n"),
      rgContext("a.ts", 3, "ctx-after-m2\n"),
    ];
    const exact = createFakeLauncher({ stdoutChunks: exactStream });
    const exactTool = grepToolWith({
      launcher: exact.launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const exactOutcome = await runGrep({ pattern: "m", limit: 2, context: 1 }, exactTool);
    expect(exactOutcome).toEqual({
      isError: false,
      content: ["a.ts:1: m1", "a.ts:2: m2", "a.ts-3- ctx-after-m2"].join("\n"),
    });
    expect(exact.killSignals).toEqual([]);

    const overflowStream = [
      rgMatch("a.ts", 1, "m1\n"),
      rgMatch("a.ts", 2, "m2\n"),
      rgContext("a.ts", 3, "ctx-after-m2\n"),
      rgMatch("a.ts", 4, "m3-should-not-appear\n"),
      rgContext("a.ts", 5, "ctx-after-m3-should-not-appear\n"),
    ];
    const overflow = createFakeLauncher({
      stdoutChunks: overflowStream,
      stayOpenUntilKilled: true,
    });
    const overflowTool = grepToolWith({
      launcher: overflow.launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const overflowOutcome = await runGrep({ pattern: "m", limit: 2, context: 1 }, overflowTool);
    expect(overflowOutcome).toEqual({
      isError: false,
      content: [
        "a.ts:1: m1",
        "a.ts:2: m2",
        "a.ts-3- ctx-after-m2",
        "",
        "[2 matches limit reached. Use limit=4 for more, or refine pattern]",
      ].join("\n"),
      details: { matchLimitReached: 2 },
    });
    expect(overflow.killSignals.length).toBeGreaterThanOrEqual(1);
  });

  it("truncates lines over 500 UTF-16 code units without splitting surrogate pairs and combines both cap notices", async () => {
    const lineWithEmojiAtBoundary = `${"a".repeat(499)}😀tail`;
    const { launcher } = createFakeLauncher({
      stdoutChunks: [
        rgMatch("a.ts", 1, `${lineWithEmojiAtBoundary}\n`),
        rgMatch("a.ts", 2, "second-match\n"),
      ],
      stayOpenUntilKilled: true,
    });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep({ pattern: "a", limit: 1 }, tool);
    expect(outcome).toEqual({
      isError: false,
      content: [
        `a.ts:1: ${"a".repeat(499)}... [truncated]`,
        "",
        "[1 matches limit reached. Use limit=2 for more, or refine pattern. Some lines truncated to 500 chars. Use read tool to see full lines]",
      ].join("\n"),
      details: { matchLimitReached: 1, linesTruncated: true },
    });
  });

  it("applies the shared 40 KiB Output Budget after notices so the tail preserves them", async () => {
    const chunks: string[] = [];
    for (let i = 1; i <= 150; i++) {
      chunks.push(rgMatch("big.ts", i, `${"x".repeat(400)}\n`));
    }
    const { launcher } = createFakeLauncher({
      stdoutChunks: chunks,
      stayOpenUntilKilled: true,
    });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    const outcome = await runGrep({ pattern: "x", limit: 120 }, tool);
    expect(outcome.isError).toBe(false);
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(outcome.content).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(outcome.content).toEndWith(
      "[120 matches limit reached. Use limit=240 for more, or refine pattern]",
    );
    if (!outcome.isError) {
      expect(outcome.details).toEqual({ matchLimitReached: 120 });
    }
  });

  it("clamps context values above Number.MAX_SAFE_INTEGER so ripgrep never sees exponent notation", async () => {
    const { launcher, launches } = createFakeLauncher({ stdoutChunks: [], exitCode: 1 });
    const tool = grepToolWith({
      launcher,
      acquirer: fakeAcquirer("/opt/rg"),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    await runGrep({ pattern: "needle", context: 1e25 }, tool);
    expect(launches[0]?.command).toContain(`--context=${String(Number.MAX_SAFE_INTEGER)}`);
  });

  it("ignores stderr on exit 0 and reports NON_ZERO_EXIT on exit >= 2", async () => {
    const noisy = createFakeLauncher({
      stdoutChunks: [rgMatch("a.ts", 1, "hit\n")],
      stderrChunks: ["binary file skipped\n"],
      exitCode: 0,
    });
    const noisyTool = grepToolWith({
      launcher: noisy.launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });
    expect(await runGrep({ pattern: "hit" }, noisyTool)).toEqual({
      isError: false,
      content: "a.ts:1: hit",
    });

    const withStderr = createFakeLauncher({
      stderrChunks: ["  regex parse error: unclosed group  \n"],
      exitCode: 2,
    });
    const errTool = grepToolWith({
      launcher: withStderr.launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });
    expect(await runGrep({ pattern: "(" }, errTool)).toEqual({
      isError: true,
      content: "regex parse error: unclosed group",
      error: { code: "NON_ZERO_EXIT", message: "regex parse error: unclosed group" },
    });

    const withoutStderr = createFakeLauncher({ stderrChunks: ["  \n"], exitCode: 2 });
    const fallbackErrTool = grepToolWith({
      launcher: withoutStderr.launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });
    expect(await runGrep({ pattern: "(" }, fallbackErrTool)).toEqual({
      isError: true,
      content: "ripgrep exited with code 2",
      error: { code: "NON_ZERO_EXIT", message: "ripgrep exited with code 2" },
    });
  });

  it("maps acquirer failures and spawn errors to TOOL_INTERNAL_ERROR naming ripgrep", async () => {
    const offlineAcquirer: ToolAcquirer = {
      async acquire() {
        return {
          ok: false,
          reason: "offline",
          message: "rg 16.0.0 is not available: offline mode.",
        };
      },
    };
    const missingTool = grepToolWith({
      launcher: unusedLauncher(),
      acquirer: offlineAcquirer,
      fs: fakeFs(),
    });
    const missingOutcome = await runGrep({ pattern: "x" }, missingTool);
    expect(missingOutcome.isError).toBe(true);
    if (missingOutcome.isError) {
      expect(missingOutcome.error.code).toBe("TOOL_INTERNAL_ERROR");
      expect(missingOutcome.error.message).toBe("rg 16.0.0 is not available: offline mode.");
    }

    const failingLauncher: ChildProcessLauncher = {
      launch() {
        throw new Error("ENOENT: no such file");
      },
    };
    const spawnTool = grepToolWith({
      launcher: failingLauncher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
    });
    const spawnOutcome = await runGrep({ pattern: "x" }, spawnTool);
    expect(spawnOutcome.isError).toBe(true);
    if (spawnOutcome.isError) {
      expect(spawnOutcome.error.code).toBe("TOOL_INTERNAL_ERROR");
      expect(spawnOutcome.error.message).toContain("ripgrep");
    }
  });

  it("maps stat failures during execute to NOT_FOUND and PERMISSION_DENIED", async () => {
    for (const [errno, expectedCode] of [
      ["ENOENT", "NOT_FOUND"],
      ["EACCES", "PERMISSION_DENIED"],
    ] as const) {
      const failingFs: GrepFileSystem = {
        async stat() {
          throw Object.assign(new Error(errno), { code: errno });
        },
      };
      const tool = grepToolWith({
        launcher: unusedLauncher(),
        acquirer: fakeAcquirer(),
        fs: failingFs,
      });
      const outcome = await runGrep({ pattern: "x" }, tool);
      expect(outcome.isError).toBe(true);
      if (outcome.isError) {
        expect(outcome.error.code).toBe(expectedCode);
      }
    }
  });

  it("cancels cleanly via AbortSignal before and during a ripgrep run", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const preTool = grepToolWith({
      launcher: unusedLauncher(),
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
    });
    const preOutcome = await runGrep({ pattern: "x" }, preTool, { signal: preAborted.signal });
    expect(preOutcome.isError).toBe(true);
    if (preOutcome.isError) {
      expect(preOutcome.error.code).toBe("SIGNAL");
    }

    const controller = new AbortController();
    const running = createFakeLauncher({
      stdoutChunks: [rgMatch("a.ts", 1, "first\n")],
      stayOpenUntilKilled: true,
    });
    const liveTool = grepToolWith({
      launcher: running.launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });
    setTimeout(() => controller.abort(), 20);
    const liveOutcome = await runGrep({ pattern: "x" }, liveTool, { signal: controller.signal });
    expect(liveOutcome.isError).toBe(true);
    if (liveOutcome.isError) {
      expect(liveOutcome.error.code).toBe("SIGNAL");
    }
    expect(running.killSignals.length).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(noRipgrep)("grep integration with real ripgrep", () => {
  let root: string;
  let workspace: WorkspaceResolver;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "grep-integration-")));
    const created = await createWorkspaceResolver(root);
    if (!created.ok) throw new Error(created.message);
    workspace = created.workspace;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeRealGrepTool(): ExecutableTool<typeof GrepParams> {
    const configured = createChildProcessLauncher(["CDA172_PROVIDER_KEY"]);
    if (!configured.ok) throw new Error(configured.message);
    const acquirer = createToolAcquirer({
      launcher: configured.launcher,
      env: { ...process.env, CODING_AGENT_OFFLINE: "1" },
    });
    return grepTool(configured.launcher, acquirer);
  }

  it("handles .gitignore inside vs outside a git repo, .git eligibility, globs, literal, ignoreCase, context, and file vs directory search", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "needle-target\n");
    await writeFile(join(root, "src", "keep.ts"), "line1\n-needle-TARGET\nline3\n");
    await writeFile(join(root, "src", "skip.js"), "needle-target\n");

    const tool = makeRealGrepTool();

    // Outside a git repository: .gitignore is inert, so ignored.txt IS matched.
    const outsideGit = await runGrep({ pattern: "needle-target", ignoreCase: true }, tool, {
      workspace,
    });
    expect(outsideGit.isError).toBe(false);
    expect(outsideGit.content.split("\n").sort()).toEqual([
      "ignored.txt:1: needle-target",
      "src/keep.ts:2: -needle-TARGET",
      "src/skip.js:1: needle-target",
    ]);

    // Inside a git repository: .gitignore applies, and .git itself is NOT excluded.
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "note.txt"), "needle-target\n");

    const insideGit = await runGrep({ pattern: "needle-target", ignoreCase: true }, tool, {
      workspace,
    });
    expect(insideGit.isError).toBe(false);
    expect(insideGit.content.split("\n").sort()).toEqual([
      ".git/note.txt:1: needle-target",
      "src/keep.ts:2: -needle-TARGET",
      "src/skip.js:1: needle-target",
    ]);

    // Leading ! glob excludes matching files, pattern starting with '-' stays text, literal + context work.
    const withOptions = await runGrep(
      {
        pattern: "-needle-TARGET",
        path: "src",
        glob: "!*.js",
        literal: true,
        context: 1,
      },
      tool,
      { workspace },
    );
    expect(withOptions).toEqual({
      isError: false,
      content: [
        "src/keep.ts-1- line1",
        "src/keep.ts:2: -needle-TARGET",
        "src/keep.ts-3- line3",
      ].join("\n"),
    });

    // Single-file search.
    const singleFile = await runGrep({ pattern: "needle", path: "src/skip.js" }, tool, {
      workspace,
    });
    expect(singleFile).toEqual({
      isError: false,
      content: "src/skip.js:1: needle-target",
    });

    // Path jail rejects symlinks and outside-repo paths.
    const outsideDir = await realpath(await mkdtemp(join(tmpdir(), "grep-outside-")));
    try {
      await writeFile(join(outsideDir, "secret.txt"), "needle\n");
      await symlink(join(outsideDir, "secret.txt"), join(root, "link.txt"));
      const linkRes = await runGrep({ pattern: "needle", path: "link.txt" }, tool, { workspace });
      expect(linkRes.isError && linkRes.error.code).toBe("PATH_OUTSIDE_REPO");
      const outRes = await runGrep({ pattern: "needle", path: "../" }, tool, { workspace });
      expect(outRes.isError && outRes.error.code).toBe("PATH_OUTSIDE_REPO");
      const missingRes = await runGrep({ pattern: "needle", path: "missing.ts" }, tool, {
        workspace,
      });
      expect(missingRes.isError && missingRes.error.code).toBe("NOT_FOUND");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
