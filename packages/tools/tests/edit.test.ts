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
  it("advertises a batch containing one replacement", () => {
    expect(
      Value.Check(editTool().parameters, {
        path: "a.ts",
        edits: [{ oldText: "old", newText: "new" }],
      }),
    ).toBe(true);
  });

  it("is named edit, classified mutating, and declares its parameters with typebox", () => {
    const tool = editTool();

    expect(tool.name).toBe("edit");
    expect(tool.mutation).toBe("mutating");
    expect(tool.parameters).toBe(EditParams);
    expect(Value.Check(EditParams, { path: "a.ts", edits: [] })).toBe(false);
    expect(Value.Check(EditParams, { path: "a.ts", oldText: "old", newText: "new" })).toBe(false);
    expect(
      Value.Check(EditParams, { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
    ).toBe(true);
    expect(
      Value.Check(EditParams, { path: "a.ts", edits: [{ oldText: "old", newText: "" }] }),
    ).toBe(true);
    expect(Value.Check(EditParams, { path: "", edits: [{ oldText: "old", newText: "new" }] })).toBe(
      false,
    );
    expect(
      Value.Check(EditParams, { path: "src/", edits: [{ oldText: "old", newText: "new" }] }),
    ).toBe(false);
    expect(
      Value.Check(EditParams, { path: "src/..", edits: [{ oldText: "old", newText: "new" }] }),
    ).toBe(false);
    expect(
      Value.Check(EditParams, { path: "a.ts", edits: [{ oldText: "", newText: "new" }] }),
    ).toBe(false);
    expect(Value.Check(EditParams, { path: "a.ts", edits: [{ oldText: "old" }] })).toBe(false);
    expect(Value.Check(EditParams, { path: "a.ts", edits: [{ newText: "new" }] })).toBe(false);
    expect(Value.Check(EditParams, { path: 1, edits: [{ oldText: "old", newText: "new" }] })).toBe(
      false,
    );
  });
});

describe("editing a file", () => {
  it("replaces the one occurrence and reports the canonical path and a replacement count of one", async () => {
    await writeFile(join(repo, "a.ts"), "let answer = 42;\n");

    expect(await edit({ path: "a.ts", edits: [{ oldText: "42", newText: "43" }] })).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement applied)`,
    });
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("let answer = 43;\n"))).toBe(
      true,
    );
  });

  it("applies adjacent edits in file order even when given in reverse order", async () => {
    await writeFile(join(repo, "a.ts"), "ab");

    expect(
      await edit({
        path: "a.ts",
        edits: [
          { oldText: "b", newText: "c" },
          { oldText: "a", newText: "bb" },
        ],
      }),
    ).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (2 replacements applied)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("bbc");
  });

  it("counts only ranges whose replacement changes their bytes", async () => {
    const file = join(repo, "a.ts");
    await writeFile(file, "a\r\nb");

    expect(
      await edit({
        path: "a.ts",
        edits: [
          { oldText: "a\n", newText: "a\n" },
          { oldText: "b", newText: "c" },
        ],
      }),
    ).toEqual({ isError: false, content: `${JSON.stringify(file)} (1 replacement applied)` });
    expect(await readFile(file, "utf8")).toBe("a\r\nc");
  });

  it("prefers a unique exact match even when another location would match fuzzily", async () => {
    const file = join(repo, "a.ts");
    await writeFile(file, '"one" “one”');

    expect(
      await edit({
        path: "a.ts",
        edits: [{ oldText: '"one"', newText: "two" }],
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(file, "utf8")).toBe("two “one”");
  });

  it("replaces a multi-line target", async () => {
    await writeFile(join(repo, "a.ts"), "function a() {\n  return 1;\n}\n");

    expect(
      await edit({
        path: "a.ts",
        edits: [
          { oldText: "function a() {\n  return 1;\n}", newText: "function a() {\n  return 2;\n}" },
        ],
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("function a() {\n  return 2;\n}\n");
  });

  it("matches different line endings and renders each replacement using its starting line", async () => {
    await writeFile(join(repo, "a.ts"), "untouched\nstart\r\nsecond\rfinal");

    expect(
      await edit({
        path: "a.ts",
        edits: [
          { oldText: "start\rsecond", newText: "first\nnext" },
          { oldText: "final", newText: "last\r\nline" },
        ],
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("untouched\nfirst\r\nnext\rlast\rline");
  });

  it("maps a fuzzy match back across CRLF and trims only whitespace inside the replaced range", async () => {
    await writeFile(join(repo, "a.ts"), "prefix “don’t”–one\u2002two  \r\nend  \r\nsuffix");

    expect(
      await edit({
        path: "a.ts",
        edits: [{ oldText: '"don\'t"-one two\nend', newText: "changed\nnext" }],
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("prefix changed\r\nnext  \r\nsuffix");
  });

  it("treats the target and the replacement literally rather than as a pattern", async () => {
    await writeFile(join(repo, "a.ts"), "const value = a.b;\n");

    expect(
      await edit({ path: "a.ts", edits: [{ oldText: "a.b", newText: "$&$1" }] }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("const value = $&$1;\n");
  });

  it("accepts an absolute path inside the repository", async () => {
    await writeFile(join(repo, "a.ts"), "old\n");

    expect(
      await edit({
        path: join(repo, "a.ts"),
        edits: [{ oldText: "old", newText: "new" }],
      }),
    ).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement applied)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("new\n");
  });

  it("deletes the matched text when the replacement is empty", async () => {
    await writeFile(join(repo, "a.ts"), "keep\ndrop this line\nkeep\n");

    expect(
      await edit({ path: "a.ts", edits: [{ oldText: "drop this line\n", newText: "" }] }),
    ).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement applied)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("keep\nkeep\n");
  });

  it("replaces multibyte UTF-8 text", async () => {
    await writeFile(join(repo, "a.ts"), "héllo\n");

    expect(await edit({ path: "a.ts", edits: [{ oldText: "héllo", newText: "😀" }] })).toEqual({
      isError: false,
      content: `${JSON.stringify(join(repo, "a.ts"))} (1 replacement applied)`,
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("😀\n");
  });
});

describe("refusing a match", () => {
  it("reports an overlap before a missing match later in the batch", async () => {
    await writeFile(join(repo, "a.ts"), "abcd");
    expect(
      await prepare({
        path: "a.ts",
        edits: [
          { oldText: "ab", newText: "X" },
          { oldText: "bc", newText: "Y" },
          { oldText: "missing", newText: "Z" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "OVERLAPPING_EDITS",
      message: expect.stringContaining("edits[0] and edits[1]"),
    });
  });

  it.each(["b", "bc"])("rejects an overlapping range for %s before Approval", async (target) => {
    const file = join(repo, "a.ts");
    await writeFile(file, "abc");

    expect(
      await prepare({
        path: "a.ts",
        edits: [
          { oldText: "bc", newText: "bc" },
          { oldText: target, newText: "z" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "OVERLAPPING_EDITS",
      message: expect.stringContaining(`edits[0] and edits[1] overlap in ${JSON.stringify(file)}`),
    });
    expect(await readFile(file, "utf8")).toBe("abc");
  });

  it("rejects a byte-identical batch even when each replacement changes its range", async () => {
    const file = join(repo, "a.ts");
    await writeFile(file, "ab");

    expect(
      await prepare({
        path: "a.ts",
        edits: [
          { oldText: "a", newText: "" },
          { oldText: "b", newText: "ab" },
        ],
      }),
    ).toMatchObject({ ok: false, code: "NO_CHANGE" });
    expect(await readFile(file, "utf8")).toBe("ab");
  });

  it("requires every edit to match the original file", async () => {
    const file = join(repo, "a.ts");
    await writeFile(file, "old");

    expect(
      await prepare({
        path: "a.ts",
        edits: [
          { oldText: "old", newText: "new" },
          { oldText: "new", newText: "again" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "NO_MATCH",
      message: expect.stringContaining("edits[1].oldText"),
    });
    expect(await readFile(file, "utf8")).toBe("old");
  });

  it.each([
    ["abc", " "],
    ["ＡＢＣ", "ABC"],
  ])("refuses a fuzzy target %j that does not match the file %j", async (original, target) => {
    await writeFile(join(repo, "a.ts"), original);
    expect(
      await prepare({
        path: "a.ts",
        edits: [{ oldText: target, newText: "new" }],
      }),
    ).toMatchObject({ ok: false, code: "NO_MATCH" });
  });

  it("counts overlapping placements after fuzzy folding", async () => {
    await writeFile(join(repo, "a.ts"), "–––");
    expect(
      await prepare({
        path: "a.ts",
        edits: [{ oldText: "--", newText: "new" }],
      }),
    ).toMatchObject({
      ok: false,
      code: "AMBIGUOUS_MATCH",
      message: expect.stringContaining("occurs 2 times"),
    });
  });

  it("fails with NO_MATCH and leaves the file byte-identical", async () => {
    const original = Buffer.from("let answer = 42;\n");
    await writeFile(join(repo, "a.ts"), original);
    const message = `edits[0].oldText does not occur in ${JSON.stringify(join(repo, "a.ts"))}. Read the file and copy the text to replace.`;

    expect(await edit({ path: "a.ts", edits: [{ oldText: "41", newText: "43" }] })).toEqual({
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
      `edits[0].oldText occurs 2 times in ${JSON.stringify(join(repo, "a.ts"))}. ` +
      "Add surrounding text to make it unique.";

    expect(
      await edit({ path: "a.ts", edits: [{ oldText: "return 1;", newText: "return 2;" }] }),
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

    expect(await edit({ path: "a.ts", edits: [{ oldText: "aa", newText: "b" }] })).toMatchObject({
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
      await edit({ path: "missing.ts", edits: [{ oldText: "a", newText: "b" }] }),
    ).toMatchObject({
      isError: true,
      error: {
        code: "NOT_FOUND",
        message: expect.stringContaining(
          "Supply the path of an existing file inside the repository.",
        ),
      },
    });
    expect(await readdir(repo)).toEqual([]);
  });

  it("reports a directory as IS_DIRECTORY", async () => {
    await mkdir(join(repo, "src"));
    const message = `${JSON.stringify(join(repo, "src"))} is a directory. Choose a file inside that directory.`;

    expect(await edit({ path: "src", edits: [{ oldText: "a", newText: "b" }] })).toEqual({
      isError: true,
      content: message,
      error: { code: "IS_DIRECTORY", message },
    });
    expect(await readdir(repo)).toEqual(["src"]);
  });

  it.skipIf(noFifos)("reports a FIFO as PERMISSION_DENIED", async () => {
    expect(Bun.spawnSync(["mkfifo", join(repo, "pipe")]).exitCode).toBe(0);

    expect(await edit({ path: "pipe", edits: [{ oldText: "a", newText: "b" }] })).toMatchObject({
      isError: true,
      error: {
        code: "PERMISSION_DENIED",
        message: expect.stringContaining("not a regular file"),
      },
    });
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
      await edit({ path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }, tool),
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
      await prepare({ path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
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
      await edit({ path: path(), edits: [{ oldText: "secret", newText: "changed" }] }),
    ).toMatchObject({ isError: true, error: { code: "PATH_OUTSIDE_REPO" } });
    expect(await readFile(join(sandbox, "outside.ts"), "utf8")).toBe("secret\n");
    expect(await readdir(join(sandbox, "outside"))).toEqual([]);
  });
});

describe("refusing the input", () => {
  it.each([
    ["an empty path", { path: "", edits: [{ oldText: "a", newText: "b" }] }],
    [
      "a path that ends like a directory",
      { path: "src/", edits: [{ oldText: "a", newText: "b" }] },
    ],
    ["an empty target", { path: "a.ts", edits: [{ oldText: "", newText: "b" }] }],
    ["a non-string target", { path: "a.ts", edits: [{ oldText: 1, newText: "b" }] }],
    ["a non-string replacement", { path: "a.ts", edits: [{ oldText: "a", newText: 1 }] }],
  ])("refuses %s as a schema violation", async (_, input) => {
    expect(await prepare(input as unknown as EditInput)).toMatchObject({
      ok: false,
      code: "SCHEMA_VIOLATION",
    });
    expect(await readdir(repo)).toEqual([]);
  });
});

describe("normalizing edit arguments before Schema Validation", () => {
  const change = { oldText: "old", newText: "new" };
  it.each([
    ["the repository's legacy pair", { targetContent: "old", replacementContent: "new" }],
    ["Pi's legacy pair", change],
    ["an edit object", { edits: change }],
    ["an edit object encoded as JSON", { edits: JSON.stringify(change) }],
    ["an edit array encoded as JSON", { edits: JSON.stringify([change]) }],
  ])("accepts %s", async (_, fields) => {
    const file = join(repo, "a.ts");
    await writeFile(file, "old");
    const normalized = editTool().normalizeArguments?.({ path: "a.ts", ...fields });
    if (!normalized?.ok || !Value.Check(EditParams, normalized.input)) {
      throw new Error("expected arguments accepted by the edit schema");
    }

    expect(await edit(normalized.input)).toMatchObject({ isError: false });
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it.each([
    ["legacy mixed with a batch", { targetContent: "old", edits: [change] }, "one input form"],
    ["two legacy forms", { newText: "new", replacementContent: "new" }, "one input form"],
    ["an incomplete pair", { targetContent: "old" }, "both targetContent and replacementContent"],
    ["malformed JSON", { edits: "[" }, "JSON string containing an object or array"],
    ["JSON holding a primitive", { edits: '"old"' }, "non-empty edits array"],
    ["an empty array", { edits: [] }, "non-empty edits array"],
    ["a missing replacement", { edits: [{ oldText: "old" }] }, "edits[0].newText"],
    ["an invalid second edit", { edits: [change, { ...change, oldText: "" }] }, "edits[1].oldText"],
  ])("refuses %s and identifies the correction", (_, fields, correction) => {
    const normalized = editTool().normalizeArguments?.({ path: "a.ts", ...fields });
    if (normalized?.ok !== false) throw new Error("expected the edit arguments to be rejected");
    expect(normalized.message).toStartWith('Invalid edit arguments for "a.ts".');
    expect(normalized.message).toContain(correction);
  });

  it("bounds the schema error for a very long path and keeps its correction", () => {
    const normalized = editTool().normalizeArguments?.({ path: "a".repeat(42_000) });
    if (normalized?.ok !== false) throw new Error("expected the edit arguments to be rejected");

    expect(Buffer.from(normalized.message, "utf8").byteLength).toBeLessThanOrEqual(40_960);
    expect(normalized.message).toEndWith("Supply a non-empty edits array.");
  });
});

describe("refusing text it cannot rewrite exactly", () => {
  it("refuses a file that is not valid UTF-8 and leaves its bytes untouched", async () => {
    const original = Buffer.from("caf\xe9\nold\n", "latin1");
    await writeFile(join(repo, "latin1.ts"), original);

    expect(
      await edit({ path: "latin1.ts", edits: [{ oldText: "old", newText: "new" }] }),
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
      await edit({ path: "blob.bin", edits: [{ oldText: "old", newText: "new" }] }),
    ).toMatchObject({
      isError: true,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("not valid UTF-8") },
    });
    expect((await readFile(join(repo, "blob.bin"))).equals(original)).toBe(true);
  });

  it.each([
    ["oldText", { edits: [{ oldText: "\uD83D", newText: "Z" }] }],
    ["newText", { edits: [{ oldText: "😀", newText: "\uDE00" }] }],
  ])("refuses %s containing half of a surrogate pair", async (field, input) => {
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
      await edit({ path: "emoji.ts", edits: [{ oldText: "😀", newText: "🙂" }] }),
    ).toMatchObject({ isError: false });
    expect((await readFile(join(repo, "emoji.ts"))).equals(Buffer.from("x🙂y\n"))).toBe(true);
  });

  it("keeps a UTF-8 byte order mark when the edit succeeds", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(join(repo, "bom.ts"), Buffer.concat([bom, Buffer.from("old\n")]));

    expect(
      await edit({ path: "bom.ts", edits: [{ oldText: "old", newText: "new" }] }),
    ).toMatchObject({ isError: false });
    expect(
      (await readFile(join(repo, "bom.ts"))).equals(Buffer.concat([bom, Buffer.from("new\n")])),
    ).toBe(true);
  });

  it("allows matching an interior U+FEFF while excluding the leading BOM", async () => {
    const file = join(repo, "bom.ts");
    await writeFile(file, "\uFEFFprefix\uFEFF");

    expect(
      await edit({
        path: "bom.ts",
        edits: [{ oldText: "\uFEFF", newText: "end" }],
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(file, "utf8")).toBe("\uFEFFprefixend");
  });

  it("rejects deletion that would turn an interior U+FEFF into a leading BOM", async () => {
    const file = join(repo, "bom.ts");
    await writeFile(file, "prefix\uFEFFsuffix");

    expect(
      await edit({
        path: "bom.ts",
        edits: [{ oldText: "prefix", newText: "" }],
      }),
    ).toMatchObject({
      error: { code: "SCHEMA_VIOLATION", message: expect.stringContaining("edits[0]") },
    });
    expect(await readFile(file, "utf8")).toBe("prefix\uFEFFsuffix");
  });

  it("rejects adjacent deletions that would merge CR and LF at the splice", async () => {
    const file = join(repo, "a.ts");
    await writeFile(file, "a\rxy\nb");

    expect(
      await edit({
        path: "a.ts",
        edits: [
          { oldText: "x", newText: "" },
          { oldText: "y", newText: "" },
        ],
      }),
    ).toMatchObject({
      error: {
        code: "SCHEMA_VIOLATION",
        message: expect.stringContaining("edits[0], edits[1] would merge line breaks"),
      },
    });
    expect(await readFile(file, "utf8")).toBe("a\rxy\nb");
  });
});

describe("writing atomically", () => {
  it("puts the complete batch in one temporary file beside the target before renaming it", async () => {
    await writeFile(join(repo, "a.ts"), "old first\n");
    const commit: {
      temporary?: string;
      temporaryContent?: Buffer;
      originalContent?: Buffer;
    } = {};
    let renames = 0;
    const tool = editToolWith(fs, {
      ...fs,
      rename: async (from, to) => {
        renames += 1;
        commit.temporary = from;
        commit.temporaryContent = await fs.readFile(from);
        commit.originalContent = await fs.readFile(to);
        await fs.rename(from, to);
      },
    });

    expect(
      await edit(
        {
          path: "a.ts",
          edits: [
            { oldText: "old", newText: "new" },
            { oldText: "first", newText: "second" },
          ],
        },
        tool,
      ),
    ).toMatchObject({ isError: false });

    expect(renames).toBe(1);
    expect(commit.temporaryContent?.equals(Buffer.from("new second\n"))).toBe(true);
    expect(commit.originalContent?.equals(Buffer.from("old first\n"))).toBe(true);
    if (commit.temporary === undefined) {
      throw new Error("the edit did not rename a temporary file");
    }
    expect(dirname(commit.temporary)).toBe(repo);
    expect((await readFile(join(repo, "a.ts"))).equals(Buffer.from("new second\n"))).toBe(true);
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it.skipIf(noModeBits)("preserves the permissions of the file it edits", async () => {
    await writeFile(join(repo, "run.sh"), "#!/bin/sh\necho old\n");
    await chmod(join(repo, "run.sh"), 0o751);

    expect(
      await edit({ path: "run.sh", edits: [{ oldText: "echo old", newText: "echo new" }] }),
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
      await edit({ path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }, tool),
    ).toMatchObject({ isError: true, error: { code: "PERMISSION_DENIED" } });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old\n");
    expect(await readdir(repo)).toEqual(["a.ts"]);
  });

  it("leaves the original intact and removes the batch's temporary file when the rename fails", async () => {
    await writeFile(join(repo, "a.ts"), "old first\n");
    const tool = editToolWith(fs, {
      ...fs,
      rename: async () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    });

    await expect(
      edit(
        {
          path: "a.ts",
          edits: [
            { oldText: "old", newText: "new" },
            { oldText: "first", newText: "second" },
          ],
        },
        tool,
      ),
    ).rejects.toThrow("EIO");
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old first\n");
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
      await prepare({ path: "a b.ts", edits: [{ oldText: "old", newText: "new" }] }, tool),
    ).toEqual({
      ok: true,
      prepared: {
        input: { path: "a b.ts", edits: [{ oldText: "old", newText: "new" }] },
        paths: [join(repo, "a b.ts") as RepoPath],
        summary: 'Apply 1 requested edit to "a b.ts"',
      },
    });
    expect(await readFile(join(repo, "a b.ts"), "utf8")).toBe("old\n");
  });

  it("summarizes the number of requested edits without including their text", async () => {
    await writeFile(join(repo, "a.ts"), "first\nsecond\n");
    const outcome = await prepare({
      path: "a.ts",
      edits: [
        { oldText: "first", newText: "first" },
        { oldText: "second", newText: "😀\nthird" },
      ],
    });
    if (!outcome.ok) throw new Error(`expected a prepared call, got: ${outcome.message}`);

    expect(outcome.prepared.summary).toBe('Apply 2 requested edits to "a.ts"');
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
      await prepare({ path: "a.ts", edits: [{ oldText: "missing", newText: "new" }] }, tool),
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
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
      ctx,
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    expect(await tool.execute(prepared.prepared, ctx)).toMatchObject({
      isError: true,
      error: {
        code: "PATH_OUTSIDE_REPO",
        message: expect.stringContaining("changed after prepare"),
      },
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
      await prepare({ path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }, tool),
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
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
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

  it("re-reads the file after Approval and refuses the batch when a target is no longer unique", async () => {
    await writeFile(join(repo, "a.ts"), "old first\n");
    const tool = editTool();
    const prepared = await tool.prepare(
      {
        path: "a.ts",
        edits: [
          { oldText: "first", newText: "second" },
          { oldText: "old", newText: "new" },
        ],
      },
      context(),
    );
    if (!prepared.ok) throw new Error(`expected a prepared call, got: ${prepared.message}`);

    await writeFile(join(repo, "a.ts"), "old first old\n");

    expect(await tool.execute(prepared.prepared, context())).toMatchObject({
      isError: true,
      error: { code: "AMBIGUOUS_MATCH", message: expect.stringContaining("edits[1].oldText") },
    });
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("old first old\n");
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
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
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
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
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
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
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
      { path: "a.ts", edits: [{ oldText: "inside", newText: "changed" }] },
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
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
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
