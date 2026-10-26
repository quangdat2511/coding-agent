import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutableTool,
  ExecuteContext,
  PrepareOutcome,
  RepoPath,
  ToolOutcome,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { Value } from "typebox/value";
import { createWorkspaceResolver, ReadParams, readTool } from "../src/index.ts";
import { readToolWith } from "../src/read.ts";

let sandbox: string;
let repo: string;
let workspace: WorkspaceResolver;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "read-tool-")));
  repo = join(sandbox, "repo");
  await mkdir(repo);
  const created = await createWorkspaceResolver(repo);
  if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
  workspace = created.workspace;
});

afterEach(async () => {
  await chmod(join(repo, "secret.ts"), 0o644).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
});

function context(): ExecuteContext {
  return { workspace, signal: new AbortController().signal, onProgress: () => undefined };
}

type ReadInput = { path: string; offset?: number; limit?: number };

async function prepare(
  input: ReadInput,
  tool: ExecutableTool<typeof ReadParams> = readTool(),
): Promise<PrepareOutcome<typeof ReadParams>> {
  return tool.prepare(input, context());
}

async function read(
  input: ReadInput,
  tool: ExecutableTool<typeof ReadParams> = readTool(),
): Promise<ToolOutcome> {
  const prepared = await tool.prepare(input, context());
  if (!prepared.ok) {
    return {
      isError: true,
      content: prepared.message,
      error: { code: prepared.code, message: prepared.message },
    };
  }
  return tool.execute(prepared.prepared, context());
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join("");
}

describe("the read tool's declaration", () => {
  it("is named read, classified read-only, and declares its parameters with typebox", () => {
    const tool = readTool();

    expect(tool.name).toBe("read");
    expect(tool.mutation).toBe("read_only");
    expect(tool.parameters).toBe(ReadParams);
    expect(Value.Check(ReadParams, { path: "a.ts", offset: 2, limit: 10 })).toBe(true);
    expect(Value.Check(ReadParams, { path: "a.ts", offset: 0 })).toBe(false);
    expect(Value.Check(ReadParams, { path: "a.ts", limit: 1.5 })).toBe(false);
  });
});

describe("reading a file", () => {
  it("returns numbered lines with the canonical path and the line range", async () => {
    await writeFile(join(repo, "a.ts"), "first\nsecond\nthird\n");

    expect(await read({ path: "a.ts" })).toEqual({
      isError: false,
      content: `"${join(repo, "a.ts")}" (lines 1-3 of 3)\n1 | first\n2 | second\n3 | third`,
    });
  });

  it("pads line numbers to the width of the last one shown", async () => {
    await writeFile(join(repo, "a.ts"), lines(10));

    const outcome = await read({ path: "a.ts", offset: 8 });

    expect(outcome.content.split("\n").slice(1)).toEqual([
      " 8 | line 8",
      " 9 | line 9",
      "10 | line 10",
    ]);
  });

  it("returns the window an offset and a limit select, and says how to continue", async () => {
    await writeFile(join(repo, "a.ts"), lines(10));

    expect(await read({ path: "a.ts", offset: 3, limit: 2 })).toEqual({
      isError: false,
      content:
        `"${join(repo, "a.ts")}" (lines 3-4 of 10)\n3 | line 3\n4 | line 4\n` +
        "[6 more lines; continue with offset 5]",
    });
  });

  it("returns 300 lines when no limit is given", async () => {
    await writeFile(join(repo, "a.ts"), lines(301));

    const outcome = await read({ path: "a.ts" });

    expect(outcome.content).toStartWith(`"${join(repo, "a.ts")}" (lines 1-300 of 301)\n`);
    expect(outcome.content).toEndWith("300 | line 300\n[1 more lines; continue with offset 301]");
  });

  it("keeps a final line that has no trailing newline", async () => {
    await writeFile(join(repo, "a.ts"), "first\nsecond");

    expect((await read({ path: "a.ts" })).content).toEndWith("1 | first\n2 | second");
  });

  it("reads an empty file as zero lines", async () => {
    await writeFile(join(repo, "empty.ts"), "");

    expect(await read({ path: "empty.ts" })).toEqual({
      isError: false,
      content: `"${join(repo, "empty.ts")}" (empty file)`,
    });
  });

  it("keeps CRLF line endings in the numbered output", async () => {
    await writeFile(join(repo, "crlf.ts"), "first\r\nsecond\r\n");

    const outcome = await read({ path: "crlf.ts" });

    expect(outcome.content.split("\n")).toEqual([
      `"${join(repo, "crlf.ts")}" (lines 1-2 of 2)`,
      "1 | first\r",
      "2 | second\r",
    ]);
  });
});

describe("refusing a read", () => {
  it.each([
    ["an offset below 1", { offset: 0 }],
    ["a fractional offset", { offset: 1.5 }],
    ["a limit below 1", { limit: 0 }],
    ["a fractional limit", { limit: 2.5 }],
  ])("refuses %s as a schema violation", async (_, window) => {
    await writeFile(join(repo, "a.ts"), lines(3));

    expect(await prepare({ path: "a.ts", ...window })).toMatchObject({
      ok: false,
      code: "SCHEMA_VIOLATION",
    });
  });

  it("refuses an offset past the end of the file as a schema violation", async () => {
    await writeFile(join(repo, "a.ts"), lines(3));

    expect(await read({ path: "a.ts", offset: 4 })).toMatchObject({
      isError: true,
      error: { code: "SCHEMA_VIOLATION", message: expect.stringContaining("3 lines") },
    });
  });

  it("refuses an offset past the end of an empty file as a schema violation", async () => {
    await writeFile(join(repo, "empty.ts"), "");

    expect(await read({ path: "empty.ts", offset: 2 })).toMatchObject({
      isError: true,
      error: { code: "SCHEMA_VIOLATION", message: expect.stringContaining("0 lines") },
    });
  });

  it("reports a missing file as NOT_FOUND", async () => {
    expect(await read({ path: "missing.ts" })).toMatchObject({
      isError: true,
      error: { code: "NOT_FOUND" },
    });
  });

  it("reports a directory as IS_DIRECTORY", async () => {
    await mkdir(join(repo, "src"));

    expect(await read({ path: "src" })).toMatchObject({
      isError: true,
      error: { code: "IS_DIRECTORY" },
    });
  });

  it.each([
    ["a path above the root", () => "../outside.ts"],
    ["an absolute path outside the root", () => join(sandbox, "outside.ts")],
    ["a symbolic link", () => "link.ts"],
  ])("reports %s as PATH_OUTSIDE_REPO", async (_, path) => {
    await writeFile(join(sandbox, "outside.ts"), "secret\n");
    await symlink(join(sandbox, "outside.ts"), join(repo, "link.ts"));

    expect(await read({ path: path() })).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });

  it("reports a file it cannot open as PERMISSION_DENIED", async () => {
    await writeFile(join(repo, "secret.ts"), "secret\n");
    // A process running as root ignores file permissions, so it simulates the refusal.
    const tool =
      process.getuid?.() === 0
        ? readToolWith({
            open: async () => {
              throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
            },
          })
        : await chmod(join(repo, "secret.ts"), 0o000).then(() => readTool());

    expect(await read({ path: "secret.ts" }, tool)).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("refuses a file swapped for a symbolic link after resolution as PATH_OUTSIDE_REPO", async () => {
    await writeFile(join(repo, "a.ts"), "");
    // The swap cannot be timed between resolution and open, so the open reports it as it would.
    const tool = readToolWith({
      open: async () => {
        throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
      },
    });

    expect(await read({ path: "a.ts" }, tool)).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });

  it("refuses a FIFO without waiting for a writer", async () => {
    expect(Bun.spawnSync(["mkfifo", join(repo, "pipe")]).exitCode).toBe(0);

    expect(await read({ path: "pipe" })).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("not a regular file") },
    });
  });

  it("refuses a socket as PERMISSION_DENIED", async () => {
    const server = Bun.listen({ unix: join(repo, "socket"), socket: { data() {} } });
    try {
      expect(await read({ path: "socket" })).toMatchObject({
        isError: true,
        error: {
          code: "PERMISSION_DENIED",
          message: expect.stringContaining("not a regular file"),
        },
      });
    } finally {
      server.stop();
    }
  });

  it("quotes the path so a newline in a file name cannot pass for a numbered line", async () => {
    await writeFile(join(repo, "evil\n2 | injected"), "real\n");

    const outcome = await read({ path: "evil\n2 | injected" });

    expect(outcome.content.split("\n")).toEqual([
      `${JSON.stringify(join(repo, "evil\n2 | injected"))} (lines 1-1 of 1)`,
      "1 | real",
    ]);
  });

  it("returns the read even when closing the file fails", async () => {
    await writeFile(join(repo, "a.ts"), "kept\n");
    const tool = readToolWith({
      open: async (path, flags) => {
        const handle = await fs.open(path, flags);
        return {
          stat: () => handle.stat(),
          readFile: (options) => handle.readFile(options),
          close: () =>
            handle.close().then(() => {
              throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
            }),
        };
      },
    });

    expect(await read({ path: "a.ts" }, tool)).toMatchObject({ isError: false });
  });

  it("returns an unexpected failure as a rejection for Agent Core to report", async () => {
    await writeFile(join(repo, "a.ts"), "");
    const tool = readToolWith({
      open: async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });

    await expect(read({ path: "a.ts" }, tool)).rejects.toThrow("EIO");
  });
});

describe("the two phases", () => {
  it("prepares without opening the file, returning the validated path and a summary", async () => {
    await writeFile(join(repo, "a.ts"), "");
    const tool = readToolWith({
      open: async () => {
        throw new Error("prepare must not open the file");
      },
    });

    expect(await prepare({ path: "a.ts", offset: 2, limit: 5 }, tool)).toEqual({
      ok: true,
      prepared: {
        input: { path: "a.ts", offset: 2, limit: 5 },
        paths: [join(repo, "a.ts") as RepoPath],
        summary: "read a.ts (lines 2-6)",
      },
    });
  });

  it("refuses a file swapped for a symbolic link between prepare and execute", async () => {
    await writeFile(join(repo, "a.ts"), "inside\n");
    await writeFile(join(sandbox, "outside.ts"), "secret\n");
    const tool = readTool();
    const prepared = await tool.prepare({ path: "a.ts" }, context());
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await unlink(join(repo, "a.ts"));
    await symlink(join(sandbox, "outside.ts"), join(repo, "a.ts"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });

  it("re-resolves a parent directory swapped for a symbolic link when it executes", async () => {
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "a.ts"), "inside\n");
    await mkdir(join(sandbox, "outside"));
    await writeFile(join(sandbox, "outside", "a.ts"), "secret\n");
    const tool = readTool();
    const prepared = await tool.prepare({ path: "sub/a.ts" }, context());
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    // O_NOFOLLOW only guards the final component, so a stale prepared path would still read
    // outside the repository through the swapped parent. Only resolving the input again refuses it.
    await rename(join(repo, "sub"), join(sandbox, "moved"));
    await symlink(join(sandbox, "outside"), join(repo, "sub"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });
});
