import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
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
import { editToolWith } from "../src/edit.ts";
import { createWorkspaceResolver, EditParams, editTool } from "../src/index.ts";
import { noFifos, noModeBits } from "./platform.ts";

let sandbox: string;
let repo: string;
let workspace: WorkspaceResolver;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "edit-tool-")));
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

type EditInput = Static<typeof EditParams>;

async function prepare(
  input: EditInput,
  tool: ExecutableTool<typeof EditParams> = editTool(),
): Promise<PrepareOutcome<typeof EditParams>> {
  return tool.prepare(input, context());
}

async function edit(
  input: EditInput,
  tool: ExecutableTool<typeof EditParams> = editTool(),
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

describe("the edit tool's declaration", () => {
  it("is named edit, classified mutating, and declares its parameters with typebox", () => {
    const tool = editTool();

    expect(tool.name).toBe("edit");
    expect(tool.mutation).toBe("mutating");
    expect(tool.parameters).toBe(EditParams);
    expect(
      Value.Check(EditParams, { path: "a.ts", targetContent: "old", replacementContent: "new" }),
    ).toBe(true);
    expect(
      Value.Check(EditParams, { path: "a.ts", targetContent: "old", replacementContent: "" }),
    ).toBe(true);
    expect(
      Value.Check(EditParams, { path: "", targetContent: "old", replacementContent: "new" }),
    ).toBe(false);
    expect(
      Value.Check(EditParams, { path: "src/", targetContent: "old", replacementContent: "new" }),
    ).toBe(false);
    expect(
      Value.Check(EditParams, { path: "src/..", targetContent: "old", replacementContent: "new" }),
    ).toBe(false);
    expect(
      Value.Check(EditParams, { path: "a.ts", targetContent: "", replacementContent: "new" }),
    ).toBe(false);
    expect(Value.Check(EditParams, { path: "a.ts", targetContent: "old" })).toBe(false);
    expect(Value.Check(EditParams, { path: "a.ts", replacementContent: "new" })).toBe(false);
    expect(
      Value.Check(EditParams, { path: 1, targetContent: "old", replacementContent: "new" }),
    ).toBe(false);
  });
});

describe("editing a file", () => {
  it("replaces the one occurrence and reports the canonical path and a replacement count of one", async () => {
    await writeFile(join(repo, "a.ts"), "let answer = 42;\n");

    expect(await edit({ path: "a.ts", targetContent: "42", replacementContent: "43" })).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement, 17 bytes written)`,
    });
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("let answer = 43;\n"))).toBe(
      true,
    );
  });

  it("replaces a multi-line target", async () => {
    await writeFile(join(repo, "a.ts"), "function a() {\n  return 1;\n}\n");

    expect(
      await edit({
        path: "a.ts",
        targetContent: "function a() {\n  return 1;\n}",
        replacementContent: "function a() {\n  return 2;\n}",
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("function a() {\n  return 2;\n}\n");
  });

  it("treats the target and the replacement literally rather than as a pattern", async () => {
    await writeFile(join(repo, "a.ts"), "const value = a.b;\n");

    expect(
      await edit({ path: "a.ts", targetContent: "a.b", replacementContent: "$&$1" }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("const value = $&$1;\n");
  });

  it("accepts an absolute path inside the repository", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");

    expect(
      await edit({
        path: join(repo, "a.ts"),
        targetContent: "old",
        replacementContent: "new",
      }),
    ).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement, 4 bytes written)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("new\n");
  });

  it("deletes the matched text when the replacement is empty", async () => {
    await writeFile(join(repo, "a.ts"), "keep\ndrop this line\nkeep\n");

    expect(
      await edit({ path: "a.ts", targetContent: "drop this line\n", replacementContent: "" }),
    ).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement, 10 bytes written)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("keep\nkeep\n");
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    await writeFile(join(repo, "a.ts"), "héllo\n");

    expect(await edit({ path: "a.ts", targetContent: "héllo", replacementContent: "😀" })).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement, 5 bytes written)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("😀\n");
  });
});

describe("refusing a match", () => {
  it("fails with NO_MATCH and leaves the file byte-identical", async () => {
    const original = Buffer.from("let answer = 42;\n");
    await writeFile(join(repo, "a.ts"), original);
    const message = `targetContent does not occur in ${JSON.stringify(join(repo, "a.ts"))}`;

    expect(await edit({ path: "a.ts", targetContent: "41", replacementContent: "43" })).toEqual({
      isError: true,
      content: message,
      error: { code: "NO_MATCH", message },
    });
    expect((await readFile(join(repo, "a.ts"))).equals(original)).toBe(true);
  });

  it("fails with AMBIGUOUS_MATCH and leaves the file byte-identical", async () => {
    const original = Buffer.from("return 1;\nreturn 1;\n");
    await writeFile(join(repo, "a.ts"), original);
    const message =
      `targetContent occurs 2 times in ${JSON.stringify(join(repo, "a.ts"))}; ` +
      "add surrounding text to make it unique";

    expect(
      await edit({ path: "a.ts", targetContent: "return 1;", replacementContent: "return 2;" }),
    ).toEqual({
      isError: true,
      content: message,
      error: { code: "AMBIGUOUS_MATCH", message },
    });
    expect((await readFile(join(repo, "a.ts"))).equals(original)).toBe(true);
  });

  // Replacing either placement would change different text, so an overlapping pair is not one
  // match to take.
  it("counts overlapping placements as ambiguous", async () => {
    const original = Buffer.from("aaa");
    await writeFile(join(repo, "a.ts"), original);

    expect(
      await edit({ path: "a.ts", targetContent: "aa", replacementContent: "b" }),
    ).toMatchObject({
      isError: true,
      error: {
        code: "AMBIGUOUS_MATCH",
        message: expect.stringContaining("occurs 2 times"),
      },
    });
    expect((await readFile(join(repo, "a.ts"))).equals(original)).toBe(true);
  });
});

describe("refusing a path", () => {
  it("reports a missing file as NOT_FOUND", async () => {
    expect(
      await edit({ path: "missing.ts", targetContent: "a", replacementContent: "b" }),
    ).toMatchObject({
      isError: true,
      error: { code: "NOT_FOUND", message: expect.stringContaining("does not exist") },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("reports a directory as IS_DIRECTORY", async () => {
    await mkdir(join(repo, "src"));
    const message = `${JSON.stringify(join(repo, "src"))} is a directory`;

    expect(await edit({ path: "src", targetContent: "a", replacementContent: "b" })).toEqual({
      isError: true,
      content: message,
      error: { code: "IS_DIRECTORY", message },
    });
    expect(await readdir(repo)).toEqual(["src"]);
  });

  it.skipIf(noFifos)("reports a FIFO as PERMISSION_DENIED", async () => {
    expect(Bun.spawnSync(["mkfifo", join(repo, "pipe")]).exitCode).toBe(0);

    expect(await edit({ path: "pipe", targetContent: "a", replacementContent: "b" })).toMatchObject(
      {
        isError: true,
        error: {
          code: "PERMISSION_DENIED",
          message: expect.stringContaining("not a regular file"),
        },
      },
    );
    expect(await readdir(repo)).toEqual(["pipe"]);
  });

  it("reports a file it cannot open for reading as PERMISSION_DENIED", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    // A chmod would also clear the write bits and stop at the read-only check before the read.
    const tool = editToolWith(
      {
        ...fs,
        open: async () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
      },
      fs,
    );

    expect(
      await edit({ path: "a.ts", targetContent: "old", replacementContent: "new" }, tool),
    ).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("cannot be read") },
    });
  });

  it("refuses to replace a read-only file before Approval", async () => {
    const original = Buffer.from("old\n");
    await writeFile(join(repo, "a.ts"), original);
    await chmod(join(repo, "a.ts"), 0o444);

    expect(
      await prepare({ path: "a.ts", targetContent: "old", replacementContent: "new" }),
    ).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
      message: expect.stringContaining("read-only"),
    });
    expect((await readFile(join(repo, "a.ts"))).equals(original)).toBe(true);
  });

  it.each([
    ["a path above the root", () => "../outside.ts"],
    ["an absolute path outside the root", () => join(sandbox, "outside.ts")],
    ["a symbolic link", () => "link.ts"],
    ["a path below a symbolic-link directory", () => "linked/a.ts"],
  ])("refuses %s as outside the repository", async (_, path) => {
    await writeFile(join(sandbox, "outside.ts"), "secret\n");
    await mkdir(join(sandbox, "outside"));
    await symlink(join(sandbox, "outside.ts"), join(repo, "link.ts"));
    await symlink(join(sandbox, "outside"), join(repo, "linked"));

    expect(
      await edit({ path: path(), targetContent: "secret", replacementContent: "changed" }),
    ).toMatchObject({ isError: true, error: { code: "PATH_OUTSIDE_REPO" } });
    expect(await readFile(join(sandbox, "outside.ts"), "utf8")).toBe("secret\n");
    expect(await readdir(join(sandbox, "outside"))).toEqual([]);
  });
});

describe("refusing the input", () => {
  it.each([
    ["an empty path", { path: "", targetContent: "a", replacementContent: "b" }],
    [
      "a path that ends like a directory",
      { path: "src/", targetContent: "a", replacementContent: "b" },
    ],
    ["an empty target", { path: "a.ts", targetContent: "", replacementContent: "b" }],
    ["a non-string target", { path: "a.ts", targetContent: 1, replacementContent: "b" }],
    ["a non-string replacement", { path: "a.ts", targetContent: "a", replacementContent: 1 }],
  ])("refuses %s as a schema violation", async (_, input) => {
    expect(await prepare(input as unknown as EditInput)).toMatchObject({
      ok: false,
      code: "SCHEMA_VIOLATION",
    });
    expect(await readdir(repo)).toEqual([]);
  });
});

describe("refusing text it cannot rewrite exactly", () => {
  it("refuses a file that is not valid UTF-8 and leaves its bytes untouched", async () => {
    const original = Buffer.from("caf\xe9\nold\n", "latin1");
    await writeFile(join(repo, "latin1.ts"), original);

    expect(
      await edit({ path: "latin1.ts", targetContent: "old", replacementContent: "new" }),
    ).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("not valid UTF-8") },
    });
    expect((await readFile(join(repo, "latin1.ts"))).equals(original)).toBe(true);
  });

  it("refuses a binary file and leaves its bytes untouched", async () => {
    const original = Buffer.from([0x00, 0xff, 0xfe, 0x6f, 0x6c, 0x64, 0x00]);
    await writeFile(join(repo, "blob.bin"), original);

    expect(
      await edit({ path: "blob.bin", targetContent: "old", replacementContent: "new" }),
    ).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("not valid UTF-8") },
    });
    expect((await readFile(join(repo, "blob.bin"))).equals(original)).toBe(true);
  });

  it.each([
    ["targetContent", { targetContent: "\uD83D", replacementContent: "Z" }],
    ["replacementContent", { targetContent: "😀", replacementContent: "\uDE00" }],
  ])("refuses a %s that is half of a surrogate pair", async (field, input) => {
    const original = Buffer.from("x😀y\n", "utf8");
    await writeFile(join(repo, "emoji.ts"), original);

    expect(await edit({ path: "emoji.ts", ...input })).toMatchObject({
      isError: true,
      error: { code: "SCHEMA_VIOLATION", message: expect.stringContaining(field) },
    });
    expect((await readFile(join(repo, "emoji.ts"))).equals(original)).toBe(true);
  });

  it("replaces a whole emoji", async () => {
    await writeFile(join(repo, "emoji.ts"), "x😀y\n");

    expect(
      await edit({ path: "emoji.ts", targetContent: "😀", replacementContent: "🙂" }),
    ).toMatchObject({ isError: false });
    expect((await readFile(join(repo, "emoji.ts"))).equals(Buffer.from("x🙂y\n"))).toBe(true);
  });

  it("keeps a UTF-8 byte order mark when the edit succeeds", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(join(repo, "bom.ts"), Buffer.concat([bom, Buffer.from("old\n")]));

    expect(
      await edit({ path: "bom.ts", targetContent: "old", replacementContent: "new" }),
    ).toMatchObject({ isError: false });
    expect(
      (await readFile(join(repo, "bom.ts"))).equals(Buffer.concat([bom, Buffer.from("new\n")])),
    ).toBe(true);
  });
});

describe("writing atomically", () => {
  it("puts a complete temporary file beside the target before renaming it", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const commit: {
      temporary?: string;
      temporaryContent?: Buffer;
      originalContent?: Buffer;
    } = {};
    const tool = editToolWith(fs, {
      ...fs,
      rename: async (from, to) => {
        commit.temporary = from;
        commit.temporaryContent = await fs.readFile(from);
        commit.originalContent = await fs.readFile(to);
        await fs.rename(from, to);
      },
    });

    expect(
      await edit({ path: "a.ts", targetContent: "old", replacementContent: "new" }, tool),
    ).toMatchObject({ isError: false });

    expect(commit.temporaryContent?.equals(Buffer.from("new\n"))).toBe(true);
    expect(commit.originalContent?.equals(Buffer.from("old\n"))).toBe(true);
    if (commit.temporary === undefined) {
      throw new Error("the edit did not rename a temporary file");
    }
    expect(dirname(commit.temporary)).toBe(repo);
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("new\n"))).toBe(true);
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it.skipIf(noModeBits)("preserves the permissions of the file it edits", async () => {
    await writeFile(join(repo, "run.sh"), "#!/bin/sh\necho old\n");
    await chmod(join(repo, "run.sh"), 0o751);

    expect(
      await edit({ path: "run.sh", targetContent: "echo old", replacementContent: "echo new" }),
    ).toMatchObject({ isError: false });
    expect((await stat(join(repo, "run.sh"))).mode & 0o777).toBe(0o751);
    expect(await readFile(join(repo, "run.sh"), "utf8")).toBe("#!/bin/sh\necho new\n");
  });

  it("reports a directory it cannot write as PERMISSION_DENIED", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editToolWith(fs, {
      ...fs,
      open: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    expect(
      await edit({ path: "a.ts", targetContent: "old", replacementContent: "new" }, tool),
    ).toMatchObject({ isError: true, error: { code: "PERMISSION_DENIED" } });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it("leaves the original intact and removes the temporary file when the rename fails", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editToolWith(fs, {
      ...fs,
      rename: async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });

    await expect(
      edit({ path: "a.ts", targetContent: "old", replacementContent: "new" }, tool),
    ).rejects.toThrow("EIO");
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });
});

describe("the two phases", () => {
  it("prepares without writing anything and returns the validated path and a summary", async () => {
    await writeFile(join(repo, "a b.ts"), "old\n");
    const tool = editToolWith(fs, {
      ...fs,
      mkdir: async () => {
        throw new Error("prepare must not create directories");
      },
      open: async () => {
        throw new Error("prepare must not write");
      },
      realpath: async () => {
        throw new Error("prepare must not resolve the directory");
      },
      rename: async () => {
        throw new Error("prepare must not rename the file");
      },
      unlink: async () => {
        throw new Error("prepare must not remove the file");
      },
    });

    expect(
      await prepare({ path: "a b.ts", targetContent: "old", replacementContent: "new" }, tool),
    ).toEqual({
      ok: true,
      prepared: {
        input: { path: "a b.ts", targetContent: "old", replacementContent: "new" },
        paths: [join(repo, "a b.ts") as RepoPath],
        summary: 'replace "old" with "new" in "a b.ts"',
      },
    });
    expect(await readFile(join(repo, "a b.ts"), "utf8")).toBe("old\n");
  });

  it("summarizes the replaced text as one-line previews", async () => {
    const target = "first line\nsecond line\nthird line";
    const replacement = `${"r".repeat(60)}\n`;
    await writeFile(join(repo, "a.ts"), target);
    const tool = editTool();
    const outcome = await prepare(
      { path: "a.ts", targetContent: target, replacementContent: replacement },
      tool,
    );
    if (!outcome.ok) throw new Error(`expected a prepared call, got: ${outcome.message}`);

    expect(outcome.prepared.summary).toBe(
      `replace "first line\\nsecond line\\nthird line" with "${"r".repeat(40)}..." in "a.ts"`,
    );
  });

  it("keeps a summary preview from splitting an emoji", async () => {
    const replacement = `${"a".repeat(39)}😀tail`;
    await writeFile(join(repo, "a.ts"), "x");
    const outcome = await prepare({
      path: "a.ts",
      targetContent: "x",
      replacementContent: replacement,
    });
    if (!outcome.ok) throw new Error(`expected a prepared call, got: ${outcome.message}`);

    expect(outcome.prepared.summary).toBe(`replace "x" with "${"a".repeat(39)}..." in "a.ts"`);
  });

  it("refuses a match that cannot apply before Approval", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editToolWith(fs, {
      ...fs,
      open: async () => {
        throw new Error("prepare must not write");
      },
      rename: async () => {
        throw new Error("prepare must not rename the file");
      },
      unlink: async () => {
        throw new Error("prepare must not remove the file");
      },
    });

    expect(
      await prepare({ path: "a.ts", targetContent: "missing", replacementContent: "new" }, tool),
    ).toMatchObject({ ok: false, code: "NO_MATCH" });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
  });

  it("re-validates the prepared path before writing", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const actual = workspace;
    const calls: string[] = [];
    const changing: WorkspaceResolver = {
      ...actual,
      resolveExisting: async (input) => {
        calls.push(input);
        if (calls.length === 2) {
          return { ok: false, code: "PATH_OUTSIDE_REPO", message: "changed after prepare" };
        }
        return actual.resolveExisting(input);
      },
    };
    const tool = editTool();
    const ctx = { ...context(), workspace: changing };
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      ctx,
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    expect(await tool.execute(prepared.prepared, ctx)).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO", message: "changed after prepare" },
    });
    expect(calls).toEqual(["a.ts", join(repo, "a.ts")]);
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
  });

  it("maps a parent that is not a directory in prepare to NOT_FOUND", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editToolWith(fs, {
      ...fs,
      lstat: async () => {
        throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
      },
    });

    expect(
      await prepare({ path: "a.ts", targetContent: "old", replacementContent: "new" }, tool),
    ).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      message: expect.stringContaining("a parent is not a directory"),
    });
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("old\n"))).toBe(true);
  });

  it("refuses a prepared path that no longer resolves to itself", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const actual = workspace;
    let calls = 0;
    const moving: WorkspaceResolver = {
      ...actual,
      resolveExisting: async (input) => {
        calls += 1;
        if (calls === 2) return { ok: true, path: join(repo, "elsewhere.ts") as RepoPath };
        return actual.resolveExisting(input);
      },
    };
    const tool = editTool();
    const ctx = { ...context(), workspace: moving };
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      ctx,
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    expect(await tool.execute(prepared.prepared, ctx)).toMatchObject({
      isError: true,
      error: {
        code: "PATH_OUTSIDE_REPO",
        message: expect.stringContaining("changed after it was prepared"),
      },
    });
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("old\n"))).toBe(true);
  });

  it("re-reads the file after Approval and refuses a target that is no longer unique", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editTool();
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await writeFile(join(repo, "a.ts"), "old old\n");

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "AMBIGUOUS_MATCH" },
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old old\n");
  });

  it("reports a destination directory that vanished as NOT_FOUND", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editToolWith(fs, {
      ...fs,
      realpath: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
    });
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: {
        code: "NOT_FOUND",
        message: expect.stringContaining("disappeared before it could be written"),
      },
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
  });

  it.each([
    [
      "the temporary file cannot be opened",
      {
        open: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        },
      },
    ],
    [
      "the rename finds no destination",
      {
        rename: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        },
      },
    ],
  ])("reports %s as NOT_FOUND", async (_, override) => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editToolWith(fs, { ...fs, ...override });
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "NOT_FOUND" },
    });
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("old\n"))).toBe(true);
  });

  it("reports NOT_FOUND when the file disappears before it executes", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const tool = editTool();
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await unlink(join(repo, "a.ts"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "NOT_FOUND" },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("re-resolves a target swapped for a symbolic link when it executes", async () => {
    await writeFile(join(repo, "a.ts"), "inside\n");
    await writeFile(join(sandbox, "outside.ts"), "secret\n");
    const tool = editTool();
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "inside", replacementContent: "changed" },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await unlink(join(repo, "a.ts"));
    await symlink(join(sandbox, "outside.ts"), join(repo, "a.ts"));

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "PATH_OUTSIDE_REPO" },
    });
    expect(await readFile(join(sandbox, "outside.ts"), "utf8")).toBe("secret\n");
  });

  it("does not rename after cancellation and leaves the original file intact", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");
    const controller = new AbortController();
    const tool = editToolWith(fs, {
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
    const prepared = await tool.prepare(
      { path: "a.ts", targetContent: "old", replacementContent: "new" },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await expect(
      tool.execute(prepared.prepared, { ...context(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });
});
