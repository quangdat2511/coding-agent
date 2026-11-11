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
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";
import { readToolWith } from "../src/read.ts";
import { noFifos, noNewlineNames, permissionsIgnored, socketRefusal } from "./platform.ts";

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
      content: `${JSON.stringify(join(repo, "a.ts"))} (lines 1-3 of 3)\n1 | first\n2 | second\n3 | third`,
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
        `${JSON.stringify(join(repo, "a.ts"))} (lines 3-4 of 10)\n3 | line 3\n4 | line 4\n` +
        "[6 more lines; continue with offset 5]",
    });
  });

  it("returns 300 lines when no limit is given", async () => {
    await writeFile(join(repo, "a.ts"), lines(301));

    const outcome = await read({ path: "a.ts" });

    expect(outcome.content).toStartWith(
      `${JSON.stringify(join(repo, "a.ts"))} (lines 1-300 of 301)\n`,
    );
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
      content: `${JSON.stringify(join(repo, "empty.ts"))} (empty file)`,
    });
  });

  it("keeps CRLF line endings in the numbered output", async () => {
    await writeFile(join(repo, "crlf.ts"), "first\r\nsecond\r\n");

    const outcome = await read({ path: "crlf.ts" });

    expect(outcome.content.split("\n")).toEqual([
      `${JSON.stringify(join(repo, "crlf.ts"))} (lines 1-2 of 2)`,
      "1 | first\r",
      "2 | second\r",
    ]);
  });
});

describe("bounding the read output", () => {
  // ADR 0001 §3's per-end budget, counted in bytes.
  const END_BUDGET_BYTES = 20_467;
  const encoder = new TextEncoder();

  // An independent character-by-character reference: the longest prefix and suffix that fit in the
  // shared end budget without splitting a character. A read that over-truncates fails the equality.
  function codePointHalves(text: string): { head: string; tail: string } {
    const characters = [...text];
    let head = "";
    let headBytes = 0;
    for (const character of characters) {
      const bytes = encoder.encode(character).byteLength;
      if (headBytes + bytes > END_BUDGET_BYTES) break;
      head += character;
      headBytes += bytes;
    }
    let tail = "";
    let tailBytes = 0;
    for (let index = characters.length - 1; index >= 0; index -= 1) {
      const character = characters[index] ?? "";
      const bytes = encoder.encode(character).byteLength;
      if (tailBytes + bytes > END_BUDGET_BYTES) break;
      tail = character + tail;
      tailBytes += bytes;
    }
    return { head, tail };
  }

  // 400 lines of 200 ASCII characters: reading the default 300 renders well over the budget.
  function longFile(): string {
    return Array.from(
      { length: 400 },
      (_, index) => `${String(index + 1).padStart(3, "0")}${"x".repeat(197)}`,
    ).join("\n");
  }

  it("caps a long read at exactly 40,960 UTF-8 bytes, keeping both ends", async () => {
    const content = longFile();
    const fileLines = content.split("\n");
    await writeFile(join(repo, "long.txt"), `${content}\n`);
    const rendered = [
      `${JSON.stringify(join(repo, "long.txt"))} (lines 1-300 of 400)`,
      ...fileLines.slice(0, 300).map((line, index) => `${String(index + 1).padStart(3)} | ${line}`),
      "[100 more lines; continue with offset 301]",
    ].join("\n");

    const outcome = await read({ path: "long.txt" });

    expect(outcome).toEqual({
      isError: false,
      content: rendered.slice(0, 20_467) + TOOL_OUTPUT_TRUNCATION_MARKER + rendered.slice(-20_467),
      truncated: true,
    });
    expect(new TextEncoder().encode(outcome.content).byteLength).toBe(MAX_TOOL_OUTPUT_BYTES);
  });

  it("caps a multi-byte read on code point boundaries, byte-exactly", async () => {
    const text = "é".repeat(30_000);
    await writeFile(join(repo, "wide.txt"), text);
    // A cut inside a character drops that whole character, so a multi-byte read can end a few
    // bytes under 40,960 while never splitting one.
    const rendered = `${JSON.stringify(join(repo, "wide.txt"))} (lines 1-1 of 1)\n1 | ${text}`;
    const { head, tail } = codePointHalves(rendered);
    const expected = `${head}${TOOL_OUTPUT_TRUNCATION_MARKER}${tail}`;

    const outcome = await read({ path: "wide.txt" });

    expect(outcome).toEqual({ isError: false, content: expected, truncated: true });
    expect(new TextEncoder().encode(outcome.content).byteLength).toBe(
      new TextEncoder().encode(head).byteLength + 26 + new TextEncoder().encode(tail).byteLength,
    );
    expect(outcome.content).not.toContain("\uFFFD");
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
    const tool = permissionsIgnored
      ? readToolWith({
          lstat: fs.lstat,
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
      lstat: fs.lstat,
      open: async () => {
        throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
      },
    });

    expect(await read({ path: "a.ts" }, tool)).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });

  it.skipIf(noFifos)("refuses a FIFO without waiting for a writer", async () => {
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
          message: expect.stringContaining(socketRefusal),
        },
      });
    } finally {
      server.stop();
    }
  });

  it.skipIf(noNewlineNames)(
    "quotes the path so a newline in a file name cannot pass for a numbered line",
    async () => {
      await writeFile(join(repo, "evil\n2 | injected"), "real\n");

      const outcome = await read({ path: "evil\n2 | injected" });

      expect(outcome.content.split("\n")).toEqual([
        `${JSON.stringify(join(repo, "evil\n2 | injected"))} (lines 1-1 of 1)`,
        "1 | real",
      ]);
    },
  );

  it("returns the read even when closing the file fails", async () => {
    await writeFile(join(repo, "a.ts"), "kept\n");
    const tool = readToolWith({
      lstat: fs.lstat,
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

  it("returns EOPNOTSUPP for a regular file as a rejection, not as a file of the wrong type", async () => {
    await writeFile(join(repo, "a.ts"), "");
    // A network or FUSE mount can refuse an open flag such as O_NOFOLLOW for an ordinary file.
    const tool = readToolWith({
      lstat: fs.lstat,
      open: async () => {
        throw Object.assign(new Error("EOPNOTSUPP: operation not supported"), {
          code: "EOPNOTSUPP",
        });
      },
    });

    await expect(read({ path: "a.ts" }, tool)).rejects.toThrow("EOPNOTSUPP");
  });

  it("returns an unexpected failure as a rejection for Agent Core to report", async () => {
    await writeFile(join(repo, "a.ts"), "");
    const tool = readToolWith({
      lstat: fs.lstat,
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
      lstat: fs.lstat,
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
    // outside the repository through the swapped parent. Only re-validating it refuses the read.
    await rename(join(repo, "sub"), join(sandbox, "moved"));
    await symlink(join(sandbox, "outside"), join(repo, "sub"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
  });

  it("re-validates the prepared path instead of the input", async () => {
    await writeFile(join(repo, "a.ts"), "one\n");
    const actual = workspace;
    const calls: string[] = [];
    const recording: WorkspaceResolver = {
      ...actual,
      resolveExisting: async (input) => {
        calls.push(input);
        return actual.resolveExisting(input);
      },
    };
    const tool = readTool();
    const ctx = { ...context(), workspace: recording };
    const prepared = await tool.prepare({ path: "a.ts" }, ctx);
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    expect(await tool.execute(prepared.prepared, ctx)).toMatchObject({ isError: false });
    expect(calls).toEqual(["a.ts", join(repo, "a.ts")]);
  });

  it("refuses a prepared path that no longer resolves to itself", async () => {
    await writeFile(join(repo, "a.ts"), "one\n");
    await writeFile(join(repo, "b.ts"), "two\n");
    const actual = workspace;
    let calls = 0;
    const moving: WorkspaceResolver = {
      ...actual,
      resolveExisting: async (input) => {
        calls += 1;
        if (calls === 2) return { ok: true, path: join(repo, "b.ts") as RepoPath };
        return actual.resolveExisting(input);
      },
    };
    const tool = readTool();
    const ctx = { ...context(), workspace: moving };
    const prepared = await tool.prepare({ path: "a.ts" }, ctx);
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    const outcome = await tool.execute(prepared.prepared, ctx);
    if (!outcome.isError) throw new Error("expected the read to be refused");
    expect(outcome.error).toEqual({
      code: "PATH_OUTSIDE_REPO",
      message: expect.stringContaining("changed after it was prepared"),
    });
  });
});
