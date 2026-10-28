import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExecutableTool,
  ExecuteContext,
  PrepareOutcome,
  RepoPath,
  ToolOutcome,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { createWorkspaceResolver, WriteParams, writeTool } from "../src/index.ts";
import { writeToolWith } from "../src/write.ts";

let sandbox: string;
let repo: string;
let workspace: WorkspaceResolver;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "write-tool-")));
  repo = join(sandbox, "repo");
  await mkdir(repo);
  const created = await createWorkspaceResolver(repo);
  if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
  workspace = created.workspace;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function context(): ExecuteContext {
  return { workspace, signal: new AbortController().signal, onProgress: () => undefined };
}

type WriteInput = Static<typeof WriteParams>;

async function prepare(
  input: WriteInput,
  tool: ExecutableTool<typeof WriteParams> = writeTool(),
): Promise<PrepareOutcome<typeof WriteParams>> {
  return tool.prepare(input, context());
}

async function write(
  input: WriteInput,
  tool: ExecutableTool<typeof WriteParams> = writeTool(),
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

describe("the write tool's declaration", () => {
  it("is named write, classified mutating, and declares its parameters with typebox", () => {
    const tool = writeTool();

    expect(tool.name).toBe("write");
    expect(tool.mutation).toBe("mutating");
    expect(tool.parameters).toBe(WriteParams);
    expect(Value.Check(WriteParams, { path: "a.ts", content: "text" })).toBe(true);
    expect(Value.Check(WriteParams, { path: "a.ts", content: "" })).toBe(true);
    expect(Value.Check(WriteParams, { path: "", content: "text" })).toBe(false);
    expect(Value.Check(WriteParams, { path: "src/", content: "text" })).toBe(false);
    expect(Value.Check(WriteParams, { path: "src/.", content: "text" })).toBe(false);
    expect(Value.Check(WriteParams, { path: "src/..", content: "text" })).toBe(false);
    expect(Value.Check(WriteParams, { path: ".", content: "text" })).toBe(false);
    expect(Value.Check(WriteParams, { path: "src/../a.ts", content: "text" })).toBe(true);
    expect(Value.Check(WriteParams, { path: 1, content: "text" })).toBe(false);
    expect(Value.Check(WriteParams, { path: "a.ts" })).toBe(false);
  });
});

describe("writing a file", () => {
  it("creates a missing file and reports the canonical path and bytes written", async () => {
    expect(await write({ path: "a.ts", content: "export const a = 1;\n" })).toEqual({
      isError: false,
      content: `"${join(repo, "a.ts")}" (20 bytes written)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("creates missing parent directories", async () => {
    expect(await write({ path: "src/new/deeper/file.ts", content: "kept\n" })).toMatchObject({
      isError: false,
    });

    expect(await readFile(join(repo, "src/new/deeper/file.ts"), "utf8")).toBe("kept\n");
  });

  it("replaces an existing file completely", async () => {
    await writeFile(join(repo, "a.ts"), "a much longer previous content\n");

    expect(await write({ path: "a.ts", content: "short\n" })).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("short\n");
  });

  it("creates an empty file", async () => {
    expect(await write({ path: "empty.ts", content: "" })).toEqual({
      isError: false,
      content: `"${join(repo, "empty.ts")}" (0 bytes written)`,
    });
    expect(await readFile(join(repo, "empty.ts"), "utf8")).toBe("");
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const content = "héllo 😀\n";

    expect(await write({ path: "wide.ts", content })).toMatchObject({
      isError: false,
      content: expect.stringContaining("(12 bytes written)"),
    });
    expect(await readFile(join(repo, "wide.ts"), "utf8")).toBe(content);
  });

  it("puts a complete temporary file beside the target before renaming it", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const commit: {
      temporary?: string;
      temporaryContent?: string;
      originalContent?: string;
    } = {};
    const tool = writeToolWith({
      ...fs,
      rename: async (from, to) => {
        commit.temporary = from;
        commit.temporaryContent = await fs.readFile(from, "utf8");
        commit.originalContent = await fs.readFile(to, "utf8");
        await fs.rename(from, to);
      },
    });

    expect(await write({ path: "a.ts", content: "new\n" }, tool)).toMatchObject({
      isError: false,
    });

    expect(commit.temporaryContent).toBe("new\n");
    expect(commit.originalContent).toBe("old\n");
    if (commit.temporary === undefined) {
      throw new Error("the write did not rename a temporary file");
    }
    expect(dirname(commit.temporary)).toBe(repo);
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("new\n");
  });

  it("flushes the temporary file before renaming it into place", async () => {
    let synced = false;
    let renameSawSync = false;
    const tool = writeToolWith({
      ...fs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        return {
          writeFile: (data, options) => handle.writeFile(data, options),
          chmod: (bits) => handle.chmod(bits),
          sync: async () => {
            await handle.sync();
            synced = true;
          },
          close: () => handle.close(),
        };
      },
      rename: async (from, to) => {
        renameSawSync = synced;
        await fs.rename(from, to);
      },
    });

    expect(await write({ path: "a.ts", content: "new\n" }, tool)).toMatchObject({
      isError: false,
    });
    expect(renameSawSync).toBe(true);
  });

  it("preserves the permissions of the file it replaces", async () => {
    await writeFile(join(repo, "run.sh"), "#!/bin/sh\n");
    await chmod(join(repo, "run.sh"), 0o751);

    expect(await write({ path: "run.sh", content: "#!/bin/sh\necho hi\n" })).toMatchObject({
      isError: false,
    });
    expect((await stat(join(repo, "run.sh"))).mode & 0o777).toBe(0o751);
  });
});

describe("refusing a write", () => {
  it("refuses to replace an existing directory before Approval", async () => {
    await mkdir(join(repo, "src"));

    expect(await prepare({ path: "src", content: "x" })).toMatchObject({
      ok: false,
      code: "IS_DIRECTORY",
    });
    expect(await readdir(repo)).toEqual(["src"]);
  });

  it("refuses to replace a FIFO as PERMISSION_DENIED", async () => {
    expect(Bun.spawnSync(["mkfifo", join(repo, "pipe")]).exitCode).toBe(0);

    expect(await prepare({ path: "pipe", content: "x" })).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
      message: expect.stringContaining("not a regular file"),
    });
    expect(await readdir(repo)).toEqual(["pipe"]);
  });

  it("refuses a path that ends like a directory as a schema violation", async () => {
    expect(await prepare({ path: "new/", content: "x" })).toMatchObject({
      ok: false,
      code: "SCHEMA_VIOLATION",
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("reports a parent that cannot be created as PARENT_CREATION_FAILED", async () => {
    const tool = writeToolWith({
      ...fs,
      mkdir: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    expect(await write({ path: "locked/a.ts", content: "x" }, tool)).toMatchObject({
      isError: true,
      error: { code: "PARENT_CREATION_FAILED" },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("reports a temporary file it cannot open as PERMISSION_DENIED", async () => {
    const tool = writeToolWith({
      ...fs,
      open: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    expect(await write({ path: "a.ts", content: "x" }, tool)).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("reports a read-only filesystem as PERMISSION_DENIED", async () => {
    const tool = writeToolWith({
      ...fs,
      open: async () => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      },
    });

    expect(await write({ path: "a.ts", content: "x" }, tool)).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("leaves the original intact and removes the temporary file when the rename fails", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = writeToolWith({
      ...fs,
      rename: async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });

    await expect(write({ path: "a.ts", content: "new\n" }, tool)).rejects.toThrow("EIO");
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it("leaves created parent directories behind when a later write fails", async () => {
    const tool = writeToolWith({
      ...fs,
      rename: async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });

    await expect(write({ path: "src/new/a.ts", content: "x" }, tool)).rejects.toThrow("EIO");
    expect((await stat(join(repo, "src/new"))).isDirectory()).toBe(true);
    expect(await readdir(join(repo, "src/new"))).toEqual([]);
  });

  it("does not rename after cancellation and leaves the original file intact", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const controller = new AbortController();
    const tool = writeToolWith({
      ...fs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        return {
          writeFile: (data, options) => handle.writeFile(data, options),
          chmod: async (bits) => {
            await handle.chmod(bits);
            controller.abort();
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    const prepared = await tool.prepare({ path: "a.ts", content: "new\n" }, context());
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await expect(
      tool.execute(prepared.prepared, { ...context(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it("closes the temporary file when writing its content fails", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    let closed = false;
    const tool = writeToolWith({
      ...fs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        return {
          writeFile: async () => {
            throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
          },
          chmod: (bits) => handle.chmod(bits),
          sync: () => handle.sync(),
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    });

    await expect(write({ path: "a.ts", content: "new\n" }, tool)).rejects.toThrow("EIO");
    expect(closed).toBe(true);
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it("returns an unexpected failure as a rejection for Agent Core to report", async () => {
    const tool = writeToolWith({
      ...fs,
      open: async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });

    await expect(write({ path: "a.ts", content: "x" }, tool)).rejects.toThrow("EIO");
  });
});

describe("the two phases", () => {
  it("prepares without creating anything, returning the validated path and a summary", async () => {
    const tool = writeToolWith({
      ...fs,
      mkdir: async () => {
        throw new Error("prepare must not create directories");
      },
      open: async () => {
        throw new Error("prepare must not open the file");
      },
      rename: async () => {
        throw new Error("prepare must not rename the file");
      },
      unlink: async () => {
        throw new Error("prepare must not remove the file");
      },
    });

    expect(await prepare({ path: "src/new/file.ts", content: "héllo\n" }, tool)).toEqual({
      ok: true,
      prepared: {
        input: { path: "src/new/file.ts", content: "héllo\n" },
        paths: [join(repo, "src/new/file.ts") as RepoPath],
        summary: "write src/new/file.ts (7 bytes)",
      },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it.each([
    ["an empty path", { path: "", content: "text" }],
    ["a non-string content", { path: "a.ts", content: 7 }],
  ])("refuses %s as a schema violation", async (_, input) => {
    const outcome = await prepare(input as unknown as WriteInput);

    expect(outcome).toMatchObject({ ok: false, code: "SCHEMA_VIOLATION" });
  });

  it.each([
    ["a path above the root", () => "../outside.ts"],
    ["an absolute path outside the root", () => join(sandbox, "outside.ts")],
    ["a symbolic link", () => "link.ts"],
    ["a path below a symbolic-link directory", () => "linked/new.ts"],
  ])("refuses %s as outside the repository", async (_, path) => {
    await writeFile(join(sandbox, "outside.ts"), "secret\n");
    await mkdir(join(sandbox, "outside"));
    await symlink(join(sandbox, "outside.ts"), join(repo, "link.ts"));
    await symlink(join(sandbox, "outside"), join(repo, "linked"));

    expect(await write({ path: path(), content: "overwritten\n" })).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
    expect(await readFile(join(sandbox, "outside.ts"), "utf8")).toBe("secret\n");
    expect(await readdir(join(sandbox, "outside"))).toEqual([]);
  });

  it("re-resolves a parent directory swapped for a symbolic link when it executes", async () => {
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "a.ts"), "inside\n");
    await mkdir(join(sandbox, "outside"));
    await writeFile(join(sandbox, "outside", "a.ts"), "secret\n");
    const tool = writeTool();
    const prepared = await tool.prepare({ path: "sub/a.ts", content: "new\n" }, context());
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await rename(join(repo, "sub"), join(sandbox, "moved"));
    await symlink(join(sandbox, "outside"), join(repo, "sub"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
    expect(await readFile(join(sandbox, "outside", "a.ts"), "utf8")).toBe("secret\n");
  });

  it("re-resolves a target swapped for a symbolic link when it executes", async () => {
    await writeFile(join(repo, "a.ts"), "inside\n");
    await writeFile(join(sandbox, "outside.ts"), "secret\n");
    const tool = writeTool();
    const prepared = await tool.prepare({ path: "a.ts", content: "new\n" }, context());
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await unlink(join(repo, "a.ts"));
    await symlink(join(sandbox, "outside.ts"), join(repo, "a.ts"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
    expect(await readFile(join(sandbox, "outside.ts"), "utf8")).toBe("secret\n");
  });
});
