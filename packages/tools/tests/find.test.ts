import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
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
import type { ChildProcess, ChildProcessLauncher } from "../src/child-process.ts";
import {
  type FindFileSystem,
  type FindOperations,
  FindParams,
  type FindRunRequest,
  type FindRunResult,
  type FindStats,
  findTool,
  findToolWith,
} from "../src/find.ts";
import {
  createChildProcessLauncher,
  createToolAcquirer,
  createWorkspaceResolver,
} from "../src/index.ts";
import type { AcquireResult, ToolAcquirer } from "../src/managed-tools.ts";
import { MAX_TOOL_OUTPUT_BYTES } from "../src/output-budget.ts";

const REPO = "/fake/repo" as RepoPath;

function fakeAcquirer(
  result: AcquireResult = { ok: true, path: "/usr/bin/fd", version: "10.5.2" },
): ToolAcquirer {
  return {
    acquire: async () => result,
  };
}

function fakeLauncher(): ChildProcessLauncher {
  return {
    launch: () => {
      throw new Error("unexpected launch in unit test");
    },
  };
}

function makeStats(kind: "file" | "dir" | "symlink"): FindStats {
  return {
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  };
}

function makeErrno(code: string, message?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message ?? `${code}: simulated error`), { code });
}

interface FakeFsOptions {
  readonly entries?: Readonly<Record<string, "file" | "dir" | "symlink">>;
  readonly gitRoots?: readonly string[];
  readonly accessErrors?: Readonly<Record<string, string>>;
  readonly statErrors?: Readonly<Record<string, string>>;
  readonly repoRoot?: string;
}

function fakeFs(options: FakeFsOptions = {}): FindFileSystem {
  const root = options.repoRoot ?? REPO;
  const entries = options.entries ?? { ".": "dir" };
  const gitRoots = options.gitRoots ?? [root];
  const resolveEntry = (rel: string): string => (rel === "." ? root : posix.join(root, rel));

  const byPath = new Map<string, "file" | "dir" | "symlink">(
    Object.entries(entries).map(([rel, kind]) => [resolveEntry(rel), kind]),
  );
  const accessErrors = new Map<string, string>(
    Object.entries(options.accessErrors ?? {}).map(([rel, code]) => [resolveEntry(rel), code]),
  );
  const statErrors = new Map<string, string>(
    Object.entries(options.statErrors ?? {}).map(([rel, code]) => [resolveEntry(rel), code]),
  );
  const gitPaths = new Set(gitRoots.map((gitRoot) => posix.join(gitRoot, ".git")));

  return {
    async stat(path) {
      const errCode = statErrors.get(path);
      if (errCode !== undefined) throw makeErrno(errCode);
      const kind = byPath.get(path);
      if (kind === undefined) throw makeErrno("ENOENT", `ENOENT: ${path}`);
      return makeStats(kind);
    },
    async lstat(path) {
      const errCode = statErrors.get(path);
      if (errCode !== undefined) throw makeErrno(errCode);
      const kind = byPath.get(path);
      if (kind === undefined) throw makeErrno("ENOENT", `ENOENT: ${path}`);
      return makeStats(kind);
    },
    async access(path) {
      const errCode = accessErrors.get(path);
      if (errCode !== undefined) throw makeErrno(errCode);
      if (!byPath.has(path)) throw makeErrno("ENOENT", `ENOENT: ${path}`);
    },
    async exists(path) {
      return gitPaths.has(path) || byPath.has(path);
    },
  };
}

function fakeOps(
  handler: (request: FindRunRequest) => Promise<FindRunResult> | FindRunResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }),
): { ops: FindOperations; requests: FindRunRequest[] } {
  const requests: FindRunRequest[] = [];
  return {
    requests,
    ops: {
      async run(request) {
        requests.push(request);
        return handler(request);
      },
    },
  };
}

function fakeWorkspace(
  resolvePath?: (input: string) => PathResolution,
  repoRoot: RepoPath = REPO,
): WorkspaceResolver {
  const defaultResolve = (input: string): PathResolution => ({
    ok: true,
    path: (input === "." || input === repoRoot
      ? repoRoot
      : input.startsWith(repoRoot)
        ? input
        : posix.join(repoRoot, input)) as RepoPath,
  });
  const fn = resolvePath ?? defaultResolve;
  return {
    repoRoot,
    resolveExisting: async (input) => fn(input),
    resolveForCreate: async (input) => fn(input),
  };
}

function makeContext(
  workspace: WorkspaceResolver = fakeWorkspace(),
  signal: AbortSignal = new AbortController().signal,
): ExecuteContext {
  return { workspace, signal, onProgress: () => undefined };
}

type FindInput = { pattern: string; path?: string; limit?: number };

async function prepare(
  input: FindInput,
  tool: ExecutableTool<typeof FindParams>,
  workspace?: WorkspaceResolver,
): Promise<PrepareOutcome<typeof FindParams>> {
  return tool.prepare(input, makeContext(workspace));
}

async function runFind(
  input: FindInput,
  tool: ExecutableTool<typeof FindParams>,
  options: { workspace?: WorkspaceResolver; signal?: AbortSignal } = {},
): Promise<ToolOutcome> {
  const ctx = makeContext(options.workspace, options.signal);
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

describe("the find tool's declaration", () => {
  it("is named find, classified read-only, and declares its parameters with typebox", () => {
    const tool = findTool(fakeLauncher(), fakeAcquirer());

    expect(tool.name).toBe("find");
    expect(tool.mutation).toBe("read_only");
    expect(tool.description).toBe(
      "Find paths by glob pattern in the repository. Returns repository-relative paths in fd's " +
        "traversal order; a directory ends with '/'. Respects .gitignore. Without '/', the pattern " +
        "matches names at any depth; with '/', it is relative to path. Output is limited to 1000 " +
        "results and 40 KiB.",
    );
    expect(tool.parameters).toBe(FindParams);
    expect(Value.Check(FindParams, { pattern: "*.ts" })).toBe(true);
    expect(Value.Check(FindParams, { pattern: "src/**/*.ts", path: "packages", limit: 10 })).toBe(
      true,
    );
    expect(Value.Check(FindParams, {})).toBe(false);
    expect(Value.Check(FindParams, { pattern: "" })).toBe(false);
    expect(Value.Check(FindParams, { pattern: "*.ts", limit: 0 })).toBe(false);
    expect(Value.Check(FindParams, { pattern: "*.ts", limit: -1 })).toBe(false);
    expect(Value.Check(FindParams, { pattern: "*.ts", limit: 1.5 })).toBe(false);
    expect(Value.Check(FindParams, { pattern: "*.ts", limti: 2 })).toBe(false);
  });
});

describe("preparing find", () => {
  it('defaults path to "." and formats the summary as find "<pattern>" in "<path>"', async () => {
    const { ops } = fakeOps();
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs(), platform: "linux" });

    expect(await prepare({ pattern: "*.ts" }, tool)).toEqual({
      ok: true,
      prepared: {
        input: { pattern: "*.ts" },
        paths: [REPO],
        summary: 'find "*.ts" in "."',
      },
    });

    expect(await prepare({ pattern: "src/*.ts", path: "packages/tools" }, tool)).toEqual({
      ok: true,
      prepared: {
        input: { pattern: "src/*.ts", path: "packages/tools" },
        paths: [posix.join(REPO, "packages/tools") as RepoPath],
        summary: 'find "src/*.ts" in "packages/tools"',
      },
    });
  });

  it.each([
    ["an empty pattern", { pattern: "" }],
    ["a limit of 0", { pattern: "*.ts", limit: 0 }],
    ["a negative limit", { pattern: "*.ts", limit: -5 }],
    ["a fractional limit", { pattern: "*.ts", limit: 2.5 }],
    ["an unknown parameter key", { pattern: "*.ts", limti: 2 } as unknown as FindInput],
  ])("refuses %s as SCHEMA_VIOLATION without clamping", async (_, input) => {
    const { ops } = fakeOps();
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });

    expect(await prepare(input, tool)).toMatchObject({
      ok: false,
      code: "SCHEMA_VIOLATION",
    });
  });
});

describe("path validation", () => {
  it("reports NOT_FOUND when the search path does not exist", async () => {
    const { ops } = fakeOps();
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });
    const ws = fakeWorkspace(() => ({
      ok: false,
      code: "NOT_FOUND",
      message: '"missing" does not exist',
    }));

    expect(await runFind({ pattern: "*.ts", path: "missing" }, tool, { workspace: ws })).toEqual({
      isError: true,
      content: '"missing" does not exist',
      error: { code: "NOT_FOUND", message: '"missing" does not exist' },
    });
  });

  it("reports NOT_A_DIRECTORY when the search path is a regular file", async () => {
    const { ops, requests } = fakeOps();
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      fs: fakeFs({ entries: { ".": "dir", "README.md": "file" } }),
    });

    const outcome = await runFind({ pattern: "*.ts", path: "README.md" }, tool);
    expect(outcome).toMatchObject({
      isError: true,
      error: { code: "NOT_A_DIRECTORY" },
    });
    expect(requests).toHaveLength(0);
  });

  it("maps workspace not_a_directory resolution failures to NOT_A_DIRECTORY", async () => {
    const { ops } = fakeOps();
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });
    const ws = fakeWorkspace(() => ({
      ok: false,
      code: "NOT_FOUND",
      reason: "not_a_directory",
      message: '"file.txt/" is not a directory',
    }));

    expect(await runFind({ pattern: "*.ts", path: "file.txt/" }, tool, { workspace: ws })).toEqual({
      isError: true,
      content: '"file.txt/" is not a directory',
      error: { code: "NOT_A_DIRECTORY", message: '"file.txt/" is not a directory' },
    });
  });

  it("reports PATH_OUTSIDE_REPO when the path escapes the repository or crosses a symlink", async () => {
    const { ops } = fakeOps();
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });
    const ws = fakeWorkspace(() => ({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: '"../outside" is outside the repository root',
    }));

    expect(await runFind({ pattern: "*.ts", path: "../outside" }, tool, { workspace: ws })).toEqual(
      {
        isError: true,
        content: '"../outside" is outside the repository root',
        error: {
          code: "PATH_OUTSIDE_REPO",
          message: '"../outside" is outside the repository root',
        },
      },
    );
  });

  it("reports PERMISSION_DENIED when the search directory is unreadable", async () => {
    const { ops, requests } = fakeOps();
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      fs: fakeFs({
        entries: { ".": "dir", secret: "dir" },
        accessErrors: { secret: "EACCES" },
      }),
    });

    const outcome = await runFind({ pattern: "*", path: "secret" }, tool);
    expect(outcome).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(requests).toHaveLength(0);
  });
});

describe("finding paths and formatting output", () => {
  it("returns repository-relative paths in fd traversal order with / for dirs and unmarked symlinks", async () => {
    const { ops, requests } = fakeOps(() => ({
      stdout: [
        `${REPO}/packages/tools/src/zeta.ts`,
        `${REPO}/packages/tools/src/sub`,
        `${REPO}/packages/tools/src/link-to-dir`,
        `${REPO}/packages/tools/.hidden-file`,
        `${REPO}/.git/HEAD`,
        `${REPO}/packages/tools/src/alpha.ts`,
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({
        entries: {
          ".": "dir",
          "packages/tools": "dir",
          "packages/tools/src/zeta.ts": "file",
          "packages/tools/src/sub": "dir",
          "packages/tools/src/link-to-dir": "symlink",
          "packages/tools/.hidden-file": "file",
          ".git/HEAD": "file",
          "packages/tools/src/alpha.ts": "file",
        },
      }),
    });

    const outcome = await runFind({ pattern: "*", path: "packages/tools" }, tool);

    expect(outcome).toEqual({
      isError: false,
      content: [
        "packages/tools/src/zeta.ts",
        "packages/tools/src/sub/",
        "packages/tools/src/link-to-dir",
        "packages/tools/.hidden-file",
        ".git/HEAD",
        "packages/tools/src/alpha.ts",
      ].join("\n"),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.cwd).toBe(REPO);
    expect(requests[0]?.args).toEqual([
      "--color=never",
      "--hidden",
      "--glob",
      "--max-results",
      "1001",
      "--",
      "*",
      posix.join(REPO, "packages/tools"),
    ]);
    // Verify no --follow, no .git exclusion, and no --type filter.
    expect(requests[0]?.args).not.toContain("--follow");
    expect(requests[0]?.args).not.toContain("--exclude");
    expect(requests[0]?.args).not.toContain("--type");
  });

  it("escapes carriage returns inside POSIX paths and preserves trailing spaces", async () => {
    const { ops } = fakeOps(() => ({
      stdout: [`${REPO}/bad\rname.ts`, `${REPO}/trailing.txt `].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({
        entries: {
          ".": "dir",
          "bad\rname.ts": "file",
          "trailing.txt ": "file",
        },
      }),
    });

    expect(await runFind({ pattern: "*" }, tool)).toEqual({
      isError: false,
      content: ["bad\\rname.ts", "trailing.txt "].join("\n"),
    });
  });

  it("returns the empty message with no details when fd matches nothing", async () => {
    const { ops } = fakeOps(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      fs: fakeFs({ entries: { ".": "dir", src: "dir" } }),
    });

    expect(await runFind({ pattern: "*.rs" }, tool)).toEqual({
      isError: false,
      content: 'No paths matching "*.rs" in "."',
    });

    expect(await runFind({ pattern: "*.rs", path: "src" }, tool)).toEqual({
      isError: false,
      content: 'No paths matching "*.rs" in "src"',
    });
  });
});

describe("fd invocation flags: gitignore, pattern anchoring, smart case, and Windows", () => {
  it("omits --no-require-git inside a git repository and passes it outside one", async () => {
    const inside = fakeOps();
    const insideTool = findToolWith({
      acquirer: fakeAcquirer(),
      ops: inside.ops,
      platform: "linux",
      fs: fakeFs({
        entries: { ".": "dir", "packages/tools": "dir" },
        gitRoots: [REPO],
      }),
    });
    await runFind({ pattern: "*.ts", path: "packages/tools" }, insideTool);
    expect(inside.requests[0]?.args).not.toContain("--no-require-git");

    const outside = fakeOps();
    const outsideTool = findToolWith({
      acquirer: fakeAcquirer(),
      ops: outside.ops,
      platform: "linux",
      fs: fakeFs({
        entries: { ".": "dir", "packages/tools": "dir" },
        gitRoots: [],
      }),
    });
    await runFind({ pattern: "*.ts", path: "packages/tools" }, outsideTool);
    expect(outside.requests[0]?.args).toContain("--no-require-git");
  });

  it("anchors relative path patterns to the escaped search root with --full-path and Pi smart case", async () => {
    const upperRoot = "/Users/Alice/Repo[1]" as RepoPath;
    const { ops, requests } = fakeOps();
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({
        repoRoot: upperRoot,
        entries: { ".": "dir", src: "dir" },
        gitRoots: [upperRoot],
      }),
    });
    const ws = fakeWorkspace(
      (input) => ({
        ok: true,
        path: (input === "." || input === upperRoot
          ? upperRoot
          : `${upperRoot}/${input}`) as RepoPath,
      }),
      upperRoot,
    );

    // Lowercase relative path pattern -> --full-path AND --ignore-case (even though root has uppercase).
    await runFind({ pattern: "./src/**/*.ts" }, tool, { workspace: ws });
    expect(requests[0]?.args).toEqual([
      "--color=never",
      "--hidden",
      "--glob",
      "--max-results",
      "1001",
      "--full-path",
      "--ignore-case",
      "--",
      "/Users/Alice/Repo\\[1\\]/src/**/*.ts",
      upperRoot,
    ]);

    // Uppercase relative path pattern -> --full-path, NO --ignore-case (leaves fd's smart case).
    await runFind({ pattern: "src/App*.ts" }, tool, { workspace: ws });
    expect(requests[1]?.args).toEqual([
      "--color=never",
      "--hidden",
      "--glob",
      "--max-results",
      "1001",
      "--full-path",
      "--",
      "/Users/Alice/Repo\\[1\\]/src/App*.ts",
      upperRoot,
    ]);

    // Leading ./ stripped leaving no / -> basename match, no --full-path, no --ignore-case.
    await runFind({ pattern: "././*.ts" }, tool, { workspace: ws });
    expect(requests[2]?.args).toEqual([
      "--color=never",
      "--hidden",
      "--glob",
      "--max-results",
      "1001",
      "--",
      "*.ts",
      upperRoot,
    ]);
  });

  it("converts backslashes in Windows patterns to / and outputs portable / paths", async () => {
    const winRepo = "C:\\Users\\Dev\\repo" as RepoPath;
    const { ops, requests } = fakeOps(() => ({
      stdout: "C:\\Users\\Dev\\repo\\src\\a.ts\r\nC:\\Users\\Dev\\repo\\src\\sub\\\r\n",
      stderr: "",
      exitCode: 0,
    }));
    const winFs: FindFileSystem = {
      async stat(path) {
        if (path === winRepo || path === "C:\\Users\\Dev\\repo\\src\\sub") return makeStats("dir");
        return makeStats("file");
      },
      async lstat(path) {
        if (path === winRepo || path === "C:\\Users\\Dev\\repo\\src\\sub") return makeStats("dir");
        return makeStats("file");
      },
      async access() {
        return;
      },
      async exists(path) {
        return path === "C:\\Users\\Dev\\repo\\.git";
      },
    };
    const ws = fakeWorkspace(
      (input) => ({
        ok: true,
        path: (input === "." || input === winRepo ? winRepo : `${winRepo}\\${input}`) as RepoPath,
      }),
      winRepo,
    );
    const tool = findToolWith({
      acquirer: fakeAcquirer({ ok: true, path: "C:\\tools\\fd.exe", version: "10.5.2" }),
      ops,
      fs: winFs,
      platform: "win32",
    });

    const outcome = await runFind({ pattern: "src\\**\\*.ts" }, tool, { workspace: ws });

    expect(requests[0]?.args).toEqual([
      "--color=never",
      "--hidden",
      "--glob",
      "--max-results",
      "1001",
      "--full-path",
      "--ignore-case",
      "--",
      "C:/Users/Dev/repo/src/**/*.ts",
      winRepo,
    ]);
    expect(outcome).toEqual({
      isError: false,
      content: ["src/a.ts", "src/sub/"].join("\n"),
    });
  });
});

describe("result limit, byte cap, and golden notices", () => {
  it("asks fd for limit + 1, prints exactly limit, and appends the golden limit notice and details", async () => {
    const fdLines: string[] = [];
    const entries: Record<string, "file" | "dir"> = { ".": "dir" };
    for (let i = 1; i <= 1001; i += 1) {
      const name = `f-${String(i).padStart(4, "0")}.ts`;
      fdLines.push(`${REPO}/${name}`);
      entries[name] = "file";
    }
    const { ops, requests } = fakeOps(() => ({
      stdout: fdLines.join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({ entries }),
    });

    const outcome = await runFind({ pattern: "*.ts" }, tool);

    expect(requests[0]?.args).toContain("1001");
    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    const lines = outcome.content.split("\n");
    expect(lines).toHaveLength(1001);
    expect(lines[0]).toBe("f-0001.ts");
    expect(lines[999]).toBe("f-1000.ts");
    expect(lines[1000]).toBe(
      "[1000 results limit reached. Use limit=2000 for more, or refine pattern]",
    );
    expect(outcome.truncated).toBeUndefined();
    expect(outcome.details).toEqual({ resultLimitReached: 1000 });
  });

  it("does not emit a limit notice when fd returns exactly limit results", async () => {
    const { ops } = fakeOps(() => ({
      stdout: [`${REPO}/a.ts`, `${REPO}/b.ts`].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({ entries: { ".": "dir", "a.ts": "file", "b.ts": "file" } }),
    });

    expect(await runFind({ pattern: "*.ts", limit: 2 }, tool)).toEqual({
      isError: false,
      content: ["a.ts", "b.ts"].join("\n"),
    });
  });

  it("caps output on whole lines at 40 KiB with the golden marker and truncation details", async () => {
    // 450 paths of 100 ASCII bytes each -> 45,449 bytes total (> 40,960).
    // Marker "[...output truncated...]" is 24 bytes + "\n" (1 byte) = 25 bytes reserved.
    // Remaining line budget = 40,935 bytes -> 405 lines (101 * 405 - 1 = 40,904 <= 40,935).
    const fdLines: string[] = [];
    const entries: Record<string, "file" | "dir"> = { ".": "dir" };
    for (let i = 1; i <= 450; i += 1) {
      const name = `${String(i).padStart(3, "0")}-${"x".repeat(96)}`;
      fdLines.push(`${REPO}/${name}`);
      entries[name] = "file";
    }
    const { ops } = fakeOps(() => ({
      stdout: fdLines.join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({ entries }),
    });

    const outcome = await runFind({ pattern: "*" }, tool);

    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    const lines = outcome.content.split("\n");
    expect(lines).toHaveLength(406);
    expect(lines[0]).toBe(`001-${"x".repeat(96)}`);
    expect(lines[404]).toBe(`405-${"x".repeat(96)}`);
    expect(lines[405]).toBe("[...output truncated...]");
    expect(Buffer.from(outcome.content, "utf8").byteLength).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    expect(outcome.truncated).toBe(true);
    expect(outcome.details).toEqual({
      truncation: {
        collectedResults: 450,
        outputResults: 405,
        collectedBytes: 450 * 100 + 449,
        outputBytes: 405 * 100 + 404,
      },
    });
  });

  it("prints only the marker and reports zero outputResults when even the first line exceeds 40 KiB", async () => {
    const huge = "a".repeat(MAX_TOOL_OUTPUT_BYTES + 10);
    const { ops } = fakeOps(() => ({
      stdout: `${REPO}/${huge}`,
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({ entries: { ".": "dir", [huge]: "file" } }),
    });

    expect(await runFind({ pattern: "*" }, tool)).toEqual({
      isError: false,
      content: "[...output truncated...]",
      truncated: true,
      details: {
        truncation: {
          collectedResults: 1,
          outputResults: 0,
          collectedBytes: MAX_TOOL_OUTPUT_BYTES + 10,
          outputBytes: 0,
        },
      },
    });
  });

  it("joins limit notice and truncation marker with '. ' when both caps trigger", async () => {
    const fdLines: string[] = [];
    const entries: Record<string, "file" | "dir"> = { ".": "dir" };
    for (let i = 1; i <= 501; i += 1) {
      const name = `${String(i).padStart(3, "0")}-${"a".repeat(96)}`;
      fdLines.push(`${REPO}/${name}`);
      entries[name] = "file";
    }
    const { ops } = fakeOps(() => ({
      stdout: fdLines.join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({ entries }),
    });

    const outcome = await runFind({ pattern: "*", limit: 500 }, tool);

    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    const footer =
      "[500 results limit reached. Use limit=1000 for more, or refine pattern]. [...output truncated...]";
    const lines = outcome.content.split("\n");
    expect(lines.at(-1)).toBe(footer);
    expect(Buffer.from(outcome.content, "utf8").byteLength).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    expect(outcome.truncated).toBe(true);
    expect(outcome.details).toMatchObject({
      resultLimitReached: 500,
      truncation: {
        collectedResults: 500,
        outputResults: lines.length - 1,
      },
    });
  });
});

describe("fd errors, partial failures, binary availability, and abort", () => {
  it("reports NON_ZERO_EXIT with trimmed stderr when fd fails with no results", async () => {
    const { ops } = fakeOps(() => ({
      stdout: "",
      stderr: "  [fd error]: invalid glob pattern  \n",
      exitCode: 1,
    }));
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });

    expect(await runFind({ pattern: "[" }, tool)).toEqual({
      isError: true,
      content: "[fd error]: invalid glob pattern",
      error: { code: "NON_ZERO_EXIT", message: "[fd error]: invalid glob pattern" },
    });
  });

  it("falls back to 'fd exited with code N' when fd fails with empty stderr", async () => {
    const { ops } = fakeOps(() => ({
      stdout: "",
      stderr: "   ",
      exitCode: 2,
    }));
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });

    expect(await runFind({ pattern: "*.ts" }, tool)).toEqual({
      isError: true,
      content: "fd exited with code 2",
      error: { code: "NON_ZERO_EXIT", message: "fd exited with code 2" },
    });
  });

  it("succeeds with the golden partial-failure notice and details.incomplete when fd returns partial results", async () => {
    const { ops } = fakeOps(() => ({
      stdout: [`${REPO}/src/a.ts`, `${REPO}/src/b.ts`].join("\n"),
      stderr: "[fd error]: Permission denied (os error 13)\n",
      exitCode: 1,
    }));
    const tool = findToolWith({
      acquirer: fakeAcquirer(),
      ops,
      platform: "linux",
      fs: fakeFs({ entries: { ".": "dir", "src/a.ts": "file", "src/b.ts": "file" } }),
    });

    expect(await runFind({ pattern: "*.ts" }, tool)).toEqual({
      isError: false,
      content: ["src/a.ts", "src/b.ts", "[... results may be incomplete]"].join("\n"),
      details: { incomplete: { exitCode: 1 } },
    });
  });

  it("reports TOOL_INTERNAL_ERROR when spawning fd throws", async () => {
    const { ops } = fakeOps(() => {
      throw makeErrno("ENOENT", "spawn fd ENOENT");
    });
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });

    const outcome = await runFind({ pattern: "*.ts" }, tool);
    expect(outcome).toMatchObject({
      isError: true,
      error: { code: "TOOL_INTERNAL_ERROR" },
    });
    if (outcome.isError) {
      expect(outcome.error.message).toContain("spawn fd ENOENT");
    }
  });

  it("reports TOOL_INTERNAL_ERROR naming fd and 10.5.1 when fd is missing or older", async () => {
    const missingTool = findToolWith({
      acquirer: fakeAcquirer({
        ok: false,
        reason: "offline",
        message:
          "fd 10.5.2 is not available: offline mode enabled and no usable binary found on PATH (minimum supported version is 10.5.1). Install fd >= 10.5.1 on PATH or unset CODING_AGENT_OFFLINE.",
      }),
      ops: fakeOps().ops,
      fs: fakeFs(),
    });

    const missingOutcome = await runFind({ pattern: "*.ts" }, missingTool);
    expect(missingOutcome).toMatchObject({
      isError: true,
      error: { code: "TOOL_INTERNAL_ERROR" },
    });
    if (missingOutcome.isError) {
      expect(missingOutcome.error.message).toContain("fd");
      expect(missingOutcome.error.message).toContain("10.5.1");
    }

    const oldTool = findToolWith({
      acquirer: fakeAcquirer({ ok: true, path: "/usr/bin/fd", version: "10.5.0" }),
      ops: fakeOps().ops,
      fs: fakeFs(),
    });

    const oldOutcome = await runFind({ pattern: "*.ts" }, oldTool);
    expect(oldOutcome).toMatchObject({
      isError: true,
      error: { code: "TOOL_INTERNAL_ERROR" },
    });
    if (oldOutcome.isError) {
      expect(oldOutcome.error.message).toContain("fd");
      expect(oldOutcome.error.message).toContain("10.5.1");
    }
  });

  it("returns SIGNAL immediately when the abort signal is already aborted", async () => {
    const { ops, requests } = fakeOps();
    const tool = findToolWith({ acquirer: fakeAcquirer(), ops, fs: fakeFs() });
    const controller = new AbortController();
    controller.abort();

    const outcome = await runFind({ pattern: "*.ts" }, tool, { signal: controller.signal });
    expect(outcome).toEqual({
      isError: true,
      content: "fd search cancelled",
      error: { code: "SIGNAL", message: "fd search cancelled" },
    });
    expect(requests).toHaveLength(0);
  });

  it("cancels a running fd child through the shared launcher when aborted", async () => {
    const controller = new AbortController();
    let killed = false;
    let resolveExited: ((code: number) => void) | undefined;
    const launcher: ChildProcessLauncher = {
      launch(command): ChildProcess {
        if (command[0] === "taskkill") {
          killed = true;
          resolveExited?.(1);
          return {
            pid: 99999,
            stdout: new ReadableStream({ start: (c) => c.close() }),
            stderr: new ReadableStream({ start: (c) => c.close() }),
            exited: Promise.resolve(0),
            exitCode: 0,
            signalCode: null,
            kill: () => undefined,
          } as unknown as ChildProcess;
        }
        const child = {
          pid: 42424,
          stdout: new ReadableStream({ start: () => undefined }),
          stderr: new ReadableStream({ start: () => undefined }),
          exited: new Promise<number>((resolveExit) => {
            resolveExited = resolveExit;
          }),
          exitCode: null,
          signalCode: null,
          kill: () => {
            killed = true;
            resolveExited?.(1);
          },
        } as unknown as ChildProcess;
        setTimeout(() => controller.abort(), 10);
        return child;
      },
    };
    const tool = findToolWith({
      launcher,
      acquirer: fakeAcquirer(),
      fs: fakeFs(),
      killProcess: (_pid, sig) => {
        if (sig === 0) throw new Error("ESRCH");
        killed = true;
        resolveExited?.(1);
      },
    });

    const outcome = await runFind({ pattern: "*.ts" }, tool, { signal: controller.signal });
    expect(killed).toBe(true);
    expect(outcome).toEqual({
      isError: true,
      content: "fd search cancelled",
      error: { code: "SIGNAL", message: "fd search cancelled" },
    });
  });
});

// Real-fd integration test: runs only when an offline fd >= 10.5.1 is installed on this host.
const realLauncherResult = createChildProcessLauncher(["CDA173_DUMMY_CREDENTIAL"]);
if (!realLauncherResult.ok) {
  throw new Error(realLauncherResult.message);
}
const realLauncher = realLauncherResult.launcher;
const offlineAcquirer = createToolAcquirer({
  launcher: realLauncher,
  env: { ...process.env, CODING_AGENT_OFFLINE: "1" },
});
const hasRealFd = (await offlineAcquirer.acquire("fd")).ok;

describe("real fd integration", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "find-integration-")));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it.skipIf(!hasRealFd)(
    "runs real fd for hidden files, directories, symlinks, and .gitignore outside a git repo",
    async () => {
      await mkdir(join(repo, "src", "nested"), { recursive: true });
      await writeFile(join(repo, ".gitignore"), "ignored.ts\n");
      await writeFile(join(repo, "ignored.ts"), "ignored");
      await writeFile(join(repo, "src", "keep.ts"), "keep");
      await writeFile(join(repo, "src", ".hidden.ts"), "hidden");
      await symlink(join(repo, "src", "nested"), join(repo, "src", "link-dir"));

      const created = await createWorkspaceResolver(repo);
      if (!created.ok) throw new Error(created.message);
      const tool = findTool(realLauncher, offlineAcquirer);

      const outcome = await runFind({ pattern: "*" }, tool, { workspace: created.workspace });
      expect(outcome.isError).toBe(false);
      if (outcome.isError) return;
      const lines = outcome.content.split("\n");
      expect(lines).toContain("src/");
      expect(lines).toContain("src/nested/");
      expect(lines).toContain("src/keep.ts");
      expect(lines).toContain("src/.hidden.ts");
      expect(lines).toContain("src/link-dir");
      expect(lines).not.toContain("ignored.ts");
    },
  );
});
