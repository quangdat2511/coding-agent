import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
import { createWorkspaceResolver } from "../src/index.ts";
import { type LsFileSystem, LsParams, type LsStats, lsTool, lsToolWith } from "../src/ls.ts";
import { MAX_TOOL_OUTPUT_BYTES } from "../src/output-budget.ts";
import { createWorkspaceResolverWith } from "../src/workspace.ts";
import { permissionsIgnored } from "./platform.ts";

const REPO = resolve("/fake/repo") as RepoPath;

type FakeEntry =
  | { readonly kind: "file" }
  | { readonly kind: "dir" }
  | { readonly kind: "symlink" }
  | { readonly kind: "error"; readonly code: string; readonly message?: string };

interface FakeDirectory {
  readonly entries?: Readonly<Record<string, FakeEntry>>;
  readonly order?: readonly string[];
  readonly readdirError?: { readonly code: string; readonly message?: string };
}

function makeStats(kind: "file" | "dir" | "symlink"): LsStats {
  return {
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  };
}

function makeErrno(code: string, message?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message ?? `${code}: simulated error`), { code });
}

function fakeFs(dirs: Readonly<Record<string, FakeDirectory>>): LsFileSystem {
  const index = new Map<string, FakeDirectory>(
    Object.entries(dirs).map(([rel, dir]) => [rel === "." ? REPO : join(REPO, rel), dir]),
  );
  return {
    async readdir(path) {
      const dir = index.get(path);
      if (dir === undefined)
        throw makeErrno("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
      if (dir.readdirError !== undefined) {
        throw makeErrno(dir.readdirError.code, dir.readdirError.message);
      }
      if (dir.order !== undefined) return [...dir.order];
      return Object.keys(dir.entries ?? {});
    },
    async lstat(path) {
      for (const [dirPath, dir] of index) {
        const prefix = dirPath.endsWith(sep) ? dirPath : `${dirPath}${sep}`;
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        const entry = dir.entries?.[name];
        if (entry === undefined) continue;
        if (entry.kind === "error") throw makeErrno(entry.code, entry.message);
        return makeStats(entry.kind);
      }
      throw makeErrno("ENOENT", `ENOENT: no such file or directory, lstat '${path}'`);
    },
  };
}

function fakeWorkspace(
  resolve: (input: string) => PathResolution = (input) => ({
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
    resolveExisting: async (input) => resolve(input),
    resolveForCreate: async (input) => resolve(input),
  };
}

function makeContext(workspace: WorkspaceResolver = fakeWorkspace()): ExecuteContext {
  return { workspace, signal: new AbortController().signal, onProgress: () => undefined };
}

type LsInput = { path?: string; limit?: number };

async function prepare(
  input: LsInput,
  tool: ExecutableTool<typeof LsParams>,
  workspace?: WorkspaceResolver,
): Promise<PrepareOutcome<typeof LsParams>> {
  return tool.prepare(input, makeContext(workspace));
}

async function runLs(
  input: LsInput,
  tool: ExecutableTool<typeof LsParams>,
  workspace?: WorkspaceResolver,
): Promise<ToolOutcome> {
  const ctx = makeContext(workspace);
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

describe("the ls tool's declaration", () => {
  it("is named ls, classified read-only, and declares its parameters with typebox", () => {
    const tool = lsTool();

    expect(tool.name).toBe("ls");
    expect(tool.mutation).toBe("read_only");
    expect(tool.description).toBe(
      "List a directory in the repository. Returns entry names sorted case-insensitively, " +
        "directories with '/' and symbolic links with '@'. Includes dotfiles. " +
        "Output is limited to 500 entries and 40 KiB.",
    );
    expect(tool.parameters).toBe(LsParams);
    expect(Value.Check(LsParams, {})).toBe(true);
    expect(Value.Check(LsParams, { path: "src", limit: 10 })).toBe(true);
    expect(Value.Check(LsParams, { limit: 0 })).toBe(false);
    expect(Value.Check(LsParams, { limit: -1 })).toBe(false);
    expect(Value.Check(LsParams, { limit: 1.5 })).toBe(false);
    expect(Value.Check(LsParams, { limti: 2 })).toBe(false);
  });
});

describe("preparing ls", () => {
  it("defaults path to '.' and formats the summary as ls \"<path>\"", async () => {
    const tool = lsToolWith(fakeFs({ ".": { entries: {} } }));

    expect(await prepare({}, tool)).toEqual({
      ok: true,
      prepared: {
        input: {},
        paths: [REPO],
        summary: 'ls "."',
      },
    });

    expect(await prepare({ path: "src/sub" }, tool)).toEqual({
      ok: true,
      prepared: {
        input: { path: "src/sub" },
        paths: [join(REPO, "src/sub") as RepoPath],
        summary: 'ls "src/sub"',
      },
    });
  });

  it.each([
    ["a limit of 0", { limit: 0 }],
    ["a negative limit", { limit: -5 }],
    ["a fractional limit", { limit: 2.5 }],
    ["an unknown parameter key", { limti: 2 } as unknown as LsInput],
  ])("refuses %s as SCHEMA_VIOLATION without clamping", async (_, input) => {
    const tool = lsToolWith(fakeFs({ ".": { entries: {} } }));

    expect(await prepare(input, tool)).toMatchObject({
      ok: false,
      code: "SCHEMA_VIOLATION",
    });
  });
});

describe("listing entries", () => {
  it("returns bare names sorted case-insensitively with dotfiles, / for dirs, and @ for symlinks", async () => {
    const tool = lsToolWith(
      fakeFs({
        ".": {
          order: ["zebra.ts", ".gitignore", "Alpha", "beta.ts", "dangling", "link-to-dir", "alpha"],
          entries: {
            "zebra.ts": { kind: "file" },
            ".gitignore": { kind: "file" },
            Alpha: { kind: "dir" },
            alpha: { kind: "file" },
            "beta.ts": { kind: "file" },
            dangling: { kind: "symlink" },
            "link-to-dir": { kind: "symlink" },
          },
        },
      }),
    );

    expect(await runLs({}, tool)).toEqual({
      isError: false,
      content: [
        ".gitignore",
        "Alpha/",
        "alpha",
        "beta.ts",
        "dangling@",
        "link-to-dir@",
        "zebra.ts",
      ].join("\n"),
    });
  });

  it("escapes carriage returns and newlines inside entry names", async () => {
    const tool = lsToolWith(
      fakeFs({
        ".": {
          entries: {
            "bad\nname.ts": { kind: "file" },
            "win\rname": { kind: "dir" },
          },
        },
      }),
    );

    expect(await runLs({}, tool)).toEqual({
      isError: false,
      content: ["bad\\nname.ts", "win\\rname/"].join("\n"),
    });
  });

  it("reports an empty directory with its golden message and no details", async () => {
    const tool = lsToolWith(
      fakeFs({
        ".": { entries: {} },
        empty: { entries: {} },
      }),
    );

    expect(await runLs({}, tool)).toEqual({
      isError: false,
      content: '"." (empty directory)',
    });

    expect(await runLs({ path: "empty" }, tool)).toEqual({
      isError: false,
      content: '"empty" (empty directory)',
    });
  });

  it("skips entries whose lstat fails and counts them in details.skippedEntries", async () => {
    const tool = lsToolWith(
      fakeFs({
        ".": {
          entries: {
            "a.ts": { kind: "file" },
            "gone.ts": { kind: "error", code: "ENOENT" },
            "denied.ts": { kind: "error", code: "EACCES" },
            src: { kind: "dir" },
          },
        },
      }),
    );

    expect(await runLs({}, tool)).toEqual({
      isError: false,
      content: ["a.ts", "src/"].join("\n"),
      details: { skippedEntries: 2 },
    });
  });

  it("reports no readable entries when every lstat fails", async () => {
    const tool = lsToolWith(
      fakeFs({
        locked: {
          entries: {
            "one.ts": { kind: "error", code: "EACCES" },
            "two.ts": { kind: "error", code: "ENOENT" },
          },
        },
      }),
    );

    expect(await runLs({ path: "locked" }, tool)).toEqual({
      isError: false,
      content: '"locked" (no readable entries)',
      details: { skippedEntries: 2 },
    });
  });
});

describe("entry limit and byte cap", () => {
  it("applies the default limit of 500 and appends the golden limit notice", async () => {
    const entries: Record<string, FakeEntry> = {};
    for (let i = 1; i <= 501; i += 1) {
      entries[`file-${String(i).padStart(3, "0")}.ts`] = { kind: "file" };
    }
    const tool = lsToolWith(fakeFs({ ".": { entries } }));

    const outcome = await runLs({}, tool);

    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    const lines = outcome.content.split("\n");
    expect(lines).toHaveLength(501);
    expect(lines[0]).toBe("file-001.ts");
    expect(lines[499]).toBe("file-500.ts");
    expect(lines[500]).toBe("[500 entries limit reached. Use limit=1000 for more]");
    expect(outcome.truncated).toBeUndefined();
    expect(outcome.details).toEqual({ entryLimitReached: 500 });
  });

  it("respects a custom limit and only lstats the first limit sorted entries", async () => {
    const statCalls: string[] = [];
    const base = fakeFs({
      ".": {
        entries: {
          "c.ts": { kind: "file" },
          "a.ts": { kind: "file" },
          "b.ts": { kind: "file" },
        },
      },
    });
    const tool = lsToolWith({
      readdir: base.readdir,
      lstat: async (path) => {
        statCalls.push(path);
        return base.lstat(path);
      },
    });

    expect(await runLs({ limit: 2 }, tool)).toEqual({
      isError: false,
      content: ["a.ts", "b.ts", "[2 entries limit reached. Use limit=4 for more]"].join("\n"),
      details: { entryLimitReached: 2 },
    });
    expect(statCalls).toEqual([join(REPO, "a.ts"), join(REPO, "b.ts")]);
  });

  it("does not emit a limit notice when entry count equals limit", async () => {
    const tool = lsToolWith(
      fakeFs({
        ".": {
          entries: {
            "a.ts": { kind: "file" },
            "b.ts": { kind: "file" },
          },
        },
      }),
    );

    expect(await runLs({ limit: 2 }, tool)).toEqual({
      isError: false,
      content: ["a.ts", "b.ts"].join("\n"),
    });
  });

  it("caps output on whole lines at 40 KiB with the shared marker and truncation details", async () => {
    // 450 entries of 100 ASCII bytes each -> 45,449 bytes total (> 40,960).
    // Marker "[...output truncated...]" is 24 bytes + 1 byte for "\n" = 25 bytes reserved.
    // Remaining line budget = 40,960 - 25 = 40,935 bytes.
    // Each line is 100 bytes; k lines take 100*k + (k - 1) = 101*k - 1 bytes.
    // 101 * 405 - 1 = 40,904 <= 40,935; 101 * 406 - 1 = 41,005 > 40,935.
    const entries: Record<string, FakeEntry> = {};
    for (let i = 1; i <= 450; i += 1) {
      entries[`${String(i).padStart(3, "0")}-${"x".repeat(96)}`] = { kind: "file" };
    }
    const tool = lsToolWith(fakeFs({ ".": { entries } }));

    const outcome = await runLs({}, tool);

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
        collectedEntries: 450,
        outputEntries: 405,
        collectedBytes: 450 * 100 + 449,
        outputBytes: 405 * 100 + 404,
      },
    });
  });

  it("joins the limit notice and truncation marker with '. ' when both caps trigger", async () => {
    const entries: Record<string, FakeEntry> = {};
    for (let i = 1; i <= 501; i += 1) {
      entries[`${String(i).padStart(3, "0")}-${"a".repeat(96)}`] = { kind: "file" };
    }
    const tool = lsToolWith(fakeFs({ ".": { entries } }));

    const outcome = await runLs({}, tool);

    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    const footer = "[500 entries limit reached. Use limit=1000 for more]. [...output truncated...]";
    const lines = outcome.content.split("\n");
    expect(lines.at(-1)).toBe(footer);
    expect(Buffer.from(outcome.content, "utf8").byteLength).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    expect(outcome.truncated).toBe(true);
    expect(outcome.details).toEqual({
      entryLimitReached: 500,
      truncation: {
        collectedEntries: 500,
        outputEntries: lines.length - 1,
        collectedBytes: 500 * 100 + 499,
        outputBytes: (lines.length - 1) * 100 + (lines.length - 2),
      },
    });
  });

  it("prints only the marker with zero outputEntries when even the first line exceeds the budget", async () => {
    const huge = "é".repeat(20_500); // 41,000 UTF-8 bytes
    const tool = lsToolWith(fakeFs({ ".": { entries: { [huge]: { kind: "file" } } } }));

    const outcome = await runLs({}, tool);

    expect(outcome).toEqual({
      isError: false,
      content: "[...output truncated...]",
      truncated: true,
      details: {
        truncation: {
          collectedEntries: 1,
          outputEntries: 0,
          collectedBytes: 41_000,
          outputBytes: 0,
        },
      },
    });
  });

  it("caps long Unicode fallback messages for empty and unreadable directories at 40 KiB", async () => {
    const longRel = "é".repeat(20_500);
    const longAbs = join(REPO, longRel) as RepoPath;
    const workspace = fakeWorkspace(() => ({ ok: true, path: longAbs }));

    const emptyTool = lsToolWith({
      readdir: async () => [],
      lstat: async () => makeStats("file"),
    });
    const emptyOutcome = await runLs({ path: longRel }, emptyTool, workspace);
    expect(emptyOutcome.isError).toBe(false);
    if (!emptyOutcome.isError) {
      expect(emptyOutcome.content).toBe("[...output truncated...]");
      expect(emptyOutcome.truncated).toBe(true);
      expect(Buffer.from(emptyOutcome.content, "utf8").byteLength).toBeLessThanOrEqual(
        MAX_TOOL_OUTPUT_BYTES,
      );
      expect(emptyOutcome.details).toMatchObject({
        truncation: { collectedEntries: 0, outputEntries: 0, outputBytes: 0 },
      });
    }

    const unreadableTool = lsToolWith({
      readdir: async () => ["a.ts"],
      lstat: async () => {
        throw makeErrno("EACCES");
      },
    });
    const unreadableOutcome = await runLs({ path: longRel }, unreadableTool, workspace);
    expect(unreadableOutcome.isError).toBe(false);
    if (!unreadableOutcome.isError) {
      expect(unreadableOutcome.content).toBe("[...output truncated...]");
      expect(unreadableOutcome.truncated).toBe(true);
      expect(Buffer.from(unreadableOutcome.content, "utf8").byteLength).toBeLessThanOrEqual(
        MAX_TOOL_OUTPUT_BYTES,
      );
      expect(unreadableOutcome.details).toMatchObject({
        skippedEntries: 1,
        truncation: { collectedEntries: 0, outputEntries: 0, outputBytes: 0 },
      });
    }
  });
});

describe("cancellation", () => {
  it("stops calling lstat once the abort signal fires", async () => {
    const controller = new AbortController();
    let lstatCalls = 0;
    const tool = lsToolWith({
      readdir: async () => ["a.ts", "b.ts", "c.ts"],
      lstat: async () => {
        lstatCalls += 1;
        controller.abort(new Error("cancelled"));
        return makeStats("file");
      },
    });
    const ctx: ExecuteContext = {
      workspace: fakeWorkspace(),
      signal: controller.signal,
      onProgress: () => undefined,
    };
    const prepared = await tool.prepare({}, ctx);
    if (!prepared.ok) throw new Error(`expected prepared call, got: ${prepared.message}`);

    await expect(tool.execute(prepared.prepared, ctx)).rejects.toThrow("cancelled");
    expect(lstatCalls).toBe(1);
  });

  it("does not call readdir when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    let readdirCalls = 0;
    const tool = lsToolWith({
      readdir: async () => {
        readdirCalls += 1;
        return [];
      },
      lstat: async () => makeStats("file"),
    });
    const ctx: ExecuteContext = {
      workspace: fakeWorkspace(),
      signal: controller.signal,
      onProgress: () => undefined,
    };
    const prepared = await tool.prepare({}, ctx);
    if (!prepared.ok) throw new Error(`expected prepared call, got: ${prepared.message}`);

    await expect(tool.execute(prepared.prepared, ctx)).rejects.toThrow("already aborted");
    expect(readdirCalls).toBe(0);
  });

  it("stops immediately after readdir resolves when the signal aborts during readdir", async () => {
    const controller = new AbortController();
    let lstatCalls = 0;
    const tool = lsToolWith({
      readdir: async () => {
        controller.abort(new Error("aborted during readdir"));
        return ["b.ts", "a.ts"];
      },
      lstat: async () => {
        lstatCalls += 1;
        return makeStats("file");
      },
    });
    const ctx: ExecuteContext = {
      workspace: fakeWorkspace(),
      signal: controller.signal,
      onProgress: () => undefined,
    };
    const prepared = await tool.prepare({}, ctx);
    if (!prepared.ok) throw new Error(`expected prepared call, got: ${prepared.message}`);

    await expect(tool.execute(prepared.prepared, ctx)).rejects.toThrow("aborted during readdir");
    expect(lstatCalls).toBe(0);
  });

  it("rejects with abort when the signal aborts during the final lstat call", async () => {
    const controller = new AbortController();
    const tool = lsToolWith({
      readdir: async () => ["only.ts"],
      lstat: async () => {
        controller.abort(new Error("aborted on last entry"));
        return makeStats("file");
      },
    });
    const ctx: ExecuteContext = {
      workspace: fakeWorkspace(),
      signal: controller.signal,
      onProgress: () => undefined,
    };
    const prepared = await tool.prepare({}, ctx);
    if (!prepared.ok) throw new Error(`expected prepared call, got: ${prepared.message}`);

    await expect(tool.execute(prepared.prepared, ctx)).rejects.toThrow("aborted on last entry");
  });
});

describe("readdir error mapping", () => {
  it.each([
    ["ENOENT", "NOT_FOUND"],
    ["ENOTDIR", "NOT_A_DIRECTORY"],
    ["EACCES", "PERMISSION_DENIED"],
    ["EPERM", "PERMISSION_DENIED"],
    ["EIO", "TOOL_INTERNAL_ERROR"],
  ] as const)("maps readdir %s to %s", async (errno, expectedCode) => {
    const tool = lsToolWith(
      fakeFs({
        target: { readdirError: { code: errno, message: `${errno}: raw kernel detail` } },
      }),
    );

    const outcome = await runLs({ path: "target" }, tool);
    expect(outcome).toMatchObject({
      isError: true,
      error: { code: expectedCode },
    });
    if (expectedCode === "TOOL_INTERNAL_ERROR" && outcome.isError) {
      expect(outcome.error.message).toBe(
        `Could not list directory ${JSON.stringify(join(REPO, "target"))}`,
      );
      expect(outcome.error.message).not.toContain("raw kernel detail");
    }
  });
});

describe("real filesystem integration", () => {
  let sandbox: string;
  let repo: string;
  let workspace: WorkspaceResolver;

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(join(tmpdir(), "ls-tool-")));
    repo = join(sandbox, "repo");
    await mkdir(repo);
    const created = await createWorkspaceResolver(repo);
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
    workspace = created.workspace;
  });

  afterEach(async () => {
    await chmod(join(repo, "unreadable"), 0o755).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  it("lists files, directories, dotfiles, symlinks, and dangling symlinks on disk", async () => {
    await writeFile(join(repo, "file.ts"), "hello\n");
    await writeFile(join(repo, ".env"), "KEY=1\n");
    await mkdir(join(repo, "sub"));
    await symlink(join(repo, "file.ts"), join(repo, "file-link"));
    await symlink(join(repo, "sub"), join(repo, "dir-link"));
    await symlink(join(repo, "missing-target"), join(repo, "dangling-link"));

    expect(await runLs({}, lsTool(), workspace)).toEqual({
      isError: false,
      content: [".env", "dangling-link@", "dir-link@", "file-link@", "file.ts", "sub/"].join("\n"),
    });
  });

  it("reports a missing path as NOT_FOUND and file-blocked paths as NOT_A_DIRECTORY", async () => {
    await writeFile(join(repo, "plain.ts"), "x\n");

    expect(await runLs({ path: "missing" }, lsTool(), workspace)).toMatchObject({
      isError: true,
      error: { code: "NOT_FOUND" },
    });

    for (const filePath of ["plain.ts", "plain.ts/", "plain.ts/child"]) {
      expect(await runLs({ path: filePath }, lsTool(), workspace)).toMatchObject({
        isError: true,
        error: { code: "NOT_A_DIRECTORY" },
      });
    }

    const clonedResolver: WorkspaceResolver = {
      repoRoot: workspace.repoRoot,
      resolveExisting: async (input) => ({ ...(await workspace.resolveExisting(input)) }),
      resolveForCreate: async (input) => ({ ...(await workspace.resolveForCreate(input)) }),
    };
    expect(await runLs({ path: "plain.ts/" }, lsTool(), clonedResolver)).toMatchObject({
      isError: true,
      error: { code: "NOT_A_DIRECTORY" },
    });
  });

  it("reports NOT_A_DIRECTORY when re-validation during execute hits ENOTDIR", async () => {
    await mkdir(join(repo, "sub"));
    let failWithEnotdir = false;
    const created = await createWorkspaceResolverWith(repo, {
      ...nodeFs,
      lstat: async (path) => {
        if (failWithEnotdir && path === join(repo, "sub")) {
          throw makeErrno("ENOTDIR");
        }
        return nodeFs.lstat(path);
      },
    });
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
    const tool = lsTool();
    const ctx = makeContext(created.workspace);
    const prepared = await tool.prepare({ path: "sub" }, ctx);
    if (!prepared.ok) throw new Error(`expected prepared call, got: ${prepared.message}`);

    failWithEnotdir = true;
    expect(await tool.execute(prepared.prepared, ctx)).toMatchObject({
      isError: true,
      error: { code: "NOT_A_DIRECTORY" },
    });
  });

  it.each([
    ["a path above the root", () => "../outside"],
    ["an absolute path outside the root", () => join(sandbox, "outside")],
    ["a symbolic link to a directory", () => "link-dir"],
  ])("reports %s as PATH_OUTSIDE_REPO", async (_, target) => {
    await mkdir(join(sandbox, "outside"));
    await symlink(join(sandbox, "outside"), join(repo, "link-dir"));

    expect(await runLs({ path: target() }, lsTool(), workspace)).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });

  it.skipIf(permissionsIgnored)(
    "reports an unreadable directory as PERMISSION_DENIED",
    async () => {
      await mkdir(join(repo, "unreadable"));
      await chmod(join(repo, "unreadable"), 0o000);

      expect(await runLs({ path: "unreadable" }, lsTool(), workspace)).toMatchObject({
        isError: true,
        error: { code: "PERMISSION_DENIED" },
      });
    },
  );

  it("refuses a directory swapped for a symlink between prepare and execute", async () => {
    await mkdir(join(repo, "sub"));
    await mkdir(join(sandbox, "outside"));
    const tool = lsTool();
    const ctx = makeContext(workspace);
    const prepared = await tool.prepare({ path: "sub" }, ctx);
    if (!prepared.ok) throw new Error(`expected prepared call, got: ${prepared.message}`);

    await rm(join(repo, "sub"), { recursive: true });
    await symlink(join(sandbox, "outside"), join(repo, "sub"));

    expect(await tool.execute(prepared.prepared, ctx)).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });
});
