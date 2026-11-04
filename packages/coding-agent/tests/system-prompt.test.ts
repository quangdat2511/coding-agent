import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PathResolution, WorkspaceResolver } from "@coding-agent/agent-core";
import { createDefaultTools, createWorkspaceResolver, readTool } from "@coding-agent/tools";
import {
  assembleSystemPrompt,
  buildSystemPrompt,
  discoverProjectInstructions,
  discoverProjectInstructionsWith,
  type InstructionsFileSystem,
  MAX_PROJECT_INSTRUCTIONS_BYTES,
  PROJECT_INSTRUCTIONS_TRUNCATION_MARKER,
  packageProjectInstructions,
  type SystemPromptEnvironment,
} from "../src/system-prompt.ts";

const MAX = MAX_PROJECT_INSTRUCTIONS_BYTES;
const MARKER = PROJECT_INSTRUCTIONS_TRUNCATION_MARKER;

const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

// Creating a symbolic link needs a privilege that a Windows account may not hold.
async function symlinksAllowed(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "coding-agent-symlink-"));
  try {
    await symlink(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

const noSymlinks = !(await symlinksAllowed());

let sandbox: string;
let repo: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "coding-agent-prompt-")));
  repo = join(sandbox, "repo");
  await mkdir(repo);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function workspaceFor(root: string): Promise<WorkspaceResolver> {
  const created = await createWorkspaceResolver(root);
  if (!created.ok) throw new Error(`expected a workspace, got: ${created.message}`);
  return created.workspace;
}

interface Fakes {
  // Replaces the resolver's answer for an input; undefined keeps the real resolver's.
  readonly resolve?: (input: string) => Promise<PathResolution> | undefined;
  // Makes opening a path fail with the error returned.
  readonly open?: (path: string) => Error | undefined;
  // Answers readlink for a path; undefined keeps the real answer.
  readonly readlink?: (path: string) => string | undefined;
  // Makes stat or read on an opened file fail.
  readonly stat?: Error;
  readonly read?: Error;
}

// Records every path discovery asks the Workspace Resolver about and every file it opens, so a
// test can show that nothing but the candidate files is touched. Fakes simulate what the host
// cannot produce, such as a symbolic link on Windows without the privilege, or EACCES as root.
async function recording(fakes: Fakes = {}) {
  const real = await workspaceFor(repo);
  const asked: string[] = [];
  const opened: string[] = [];
  let bytesRead = 0;
  const workspace: WorkspaceResolver = {
    repoRoot: real.repoRoot,
    resolveExisting: (input) => {
      asked.push(input);
      return fakes.resolve?.(input) ?? real.resolveExisting(input);
    },
    resolveForCreate: (input) => {
      asked.push(input);
      return real.resolveForCreate(input);
    },
  };
  const fs: InstructionsFileSystem = {
    async open(path, flags) {
      opened.push(path);
      const failure = fakes.open?.(path);
      if (failure !== undefined) throw failure;
      const handle = await nodeFs.open(path, flags);
      return {
        async stat() {
          if (fakes.stat !== undefined) throw fakes.stat;
          return handle.stat();
        },
        close: () => handle.close(),
        async read(buffer, offset, length, position) {
          if (fakes.read !== undefined) throw fakes.read;
          const result = await handle.read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        },
      };
    },
    async readlink(path) {
      return fakes.readlink?.(path) ?? nodeFs.readlink(path);
    },
  };
  return {
    discover: () => discoverProjectInstructionsWith(workspace, fs),
    asked,
    opened,
    bytesRead: () => bytesRead,
  };
}

const errno = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });

// AGENTS.md as a symbolic link to `target`, the way the real resolver and readlink report one.
const linkedAgents = (target: string): Fakes => ({
  resolve: (input) =>
    input === "AGENTS.md"
      ? Promise.resolve({
          ok: false,
          code: "PATH_OUTSIDE_REPO",
          message: '"AGENTS.md" passes through the symbolic link "AGENTS.md"',
        })
      : undefined,
  readlink: (path) => (path === join(repo, "AGENTS.md") ? target : undefined),
});

const utf16le = (text: string): Uint8Array =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

const utf16be = (text: string): Uint8Array =>
  Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);

describe("discovering Project Instructions", () => {
  it("packages AGENTS.md and never looks at CLAUDE.md when both exist", async () => {
    await Bun.write(join(repo, "AGENTS.md"), "Use tabs.\n");
    await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
    const { discover, asked, opened } = await recording();

    expect(await discover()).toEqual({
      ok: true,
      instructions: { path: "AGENTS.md", content: "Use tabs.\n", truncated: false },
      skipped: [],
    });
    expect(asked).toEqual(["AGENTS.md"]);
    expect(opened).toEqual([join(repo, "AGENTS.md")]);
  });

  it("falls back to CLAUDE.md when there is no AGENTS.md", async () => {
    await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
    const { discover, asked } = await recording();

    expect(await discover()).toEqual({
      ok: true,
      instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
      skipped: [],
    });
    expect(asked).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("finds nothing in a repository with neither file, and opens nothing else", async () => {
    await Bun.write(join(repo, "README.md"), "# Project\n");
    await Bun.write(join(repo, "src", "index.ts"), "export {};\n");
    await Bun.write(join(repo, "docs", "AGENTS.md"), "Not at the root.\n");
    const { discover, asked, opened } = await recording();

    expect(await discover()).toEqual({ ok: true, instructions: null, skipped: [] });
    expect(asked).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(opened).toEqual([]);
  });

  it("passes over an AGENTS.md that is a directory, and says why", async () => {
    await mkdir(join(repo, "AGENTS.md"));
    await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");

    expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
      ok: true,
      instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
      skipped: [{ path: "AGENTS.md", reason: '"AGENTS.md" is not a regular file' }],
    });
  });

  it.each(["", " \n\t\n"])(
    "passes over an AGENTS.md that holds only %j, so CLAUDE.md still loads",
    async (content) => {
      await Bun.write(join(repo, "AGENTS.md"), content);
      await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");

      expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
        ok: true,
        instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
        skipped: [{ path: "AGENTS.md", reason: '"AGENTS.md" is empty' }],
      });
    },
  );

  it("has no Project Instructions when the only file is empty", async () => {
    await Bun.write(join(repo, "AGENTS.md"), "");

    expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
      ok: true,
      instructions: null,
      skipped: [{ path: "AGENTS.md", reason: '"AGENTS.md" is empty' }],
    });
  });

  describe("following a symbolic link", () => {
    it.skipIf(noSymlinks)("loads CLAUDE.md through an AGENTS.md that links to it", async () => {
      await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
      await symlink(join(repo, "CLAUDE.md"), join(repo, "AGENTS.md"));
      const { discover, opened } = await recording();

      expect(await discover()).toEqual({
        ok: true,
        instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
        skipped: [],
      });
      expect(opened).toEqual([join(repo, "CLAUDE.md")]);
    });

    it.skipIf(noSymlinks)(
      "loads the target of a relative link inside the repository, not a stale CLAUDE.md",
      async () => {
        await Bun.write(join(repo, "docs", "agents.md"), "Use tabs.\n");
        await Bun.write(join(repo, "CLAUDE.md"), "Stale.\n");
        await symlink(join("docs", "agents.md"), join(repo, "AGENTS.md"));

        expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
          ok: true,
          instructions: { path: "docs/agents.md", content: "Use tabs.\n", truncated: false },
          skipped: [],
        });
      },
    );

    it.skipIf(noSymlinks)(
      "never reads through a link to a file outside the repository",
      async () => {
        await Bun.write(join(sandbox, "secret.txt"), "sk-not-for-the-model\n");
        await symlink(join(sandbox, "secret.txt"), join(repo, "AGENTS.md"));
        const { discover, opened } = await recording();

        expect(await discover()).toEqual({
          ok: true,
          instructions: null,
          skipped: [
            {
              path: "AGENTS.md",
              reason: expect.stringContaining("is outside the repository root"),
            },
          ],
        });
        expect(opened).toEqual([]);
      },
    );

    // The cases below simulate the link, so they also run where links cannot be created.
    it.each([
      ["a relative", (): string => "docs/agents.md"],
      ["an absolute", (): string => join(repo, "docs", "agents.md")],
    ] as const)("loads the target of %s link inside the repository", async (_kind, target) => {
      await Bun.write(join(repo, "docs", "agents.md"), "Use tabs.\n");
      await Bun.write(join(repo, "CLAUDE.md"), "Stale.\n");
      const { discover, opened } = await recording(linkedAgents(target()));

      expect(await discover()).toEqual({
        ok: true,
        instructions: { path: "docs/agents.md", content: "Use tabs.\n", truncated: false },
        skipped: [],
      });
      expect(opened).toEqual([join(repo, "docs", "agents.md")]);
    });

    it("passes over a link that leaves the repository, says why, and loads CLAUDE.md", async () => {
      await Bun.write(join(sandbox, "secret.txt"), "sk-not-for-the-model\n");
      await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
      const { discover, opened } = await recording(linkedAgents(join(sandbox, "secret.txt")));

      expect(await discover()).toEqual({
        ok: true,
        instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
        skipped: [
          {
            path: "AGENTS.md",
            reason: expect.stringMatching(
              /^"AGENTS\.md" is a link, and .* is outside the repository root$/,
            ),
          },
        ],
      });
      expect(opened).toEqual([join(repo, "CLAUDE.md")]);
    });

    it("passes over a link whose target does not exist, and says why", async () => {
      const { discover } = await recording(linkedAgents("docs/missing.md"));

      expect(await discover()).toEqual({
        ok: true,
        instructions: null,
        skipped: [
          {
            path: "AGENTS.md",
            reason: '"AGENTS.md" is a link, and "docs/missing.md" does not exist',
          },
        ],
      });
    });

    it("fails when the link's target cannot be read", async () => {
      await Bun.write(join(repo, "docs", "agents.md"), "Use tabs.\n");
      const { discover } = await recording({
        ...linkedAgents("docs/agents.md"),
        open: (path) => (path.endsWith("agents.md") ? errno("EACCES") : undefined),
      });

      expect(await discover()).toEqual({
        ok: false,
        code: "INVALID_CONFIGURATION",
        field: "systemPrompt",
        message:
          "the Project Instructions file AGENTS.md cannot be read: it links to " +
          '"docs/agents.md", which cannot be read: permission denied',
      });
    });
  });

  // Git checks a link out as a plain file holding its target where it cannot create links, as on
  // Windows with core.symlinks=false.
  describe("following a link that git checked out as a plain file", () => {
    it("loads CLAUDE.md through an AGENTS.md that only holds its name", async () => {
      await Bun.write(join(repo, "AGENTS.md"), "CLAUDE.md");
      await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
      const { discover, opened } = await recording();

      expect(await discover()).toEqual({
        ok: true,
        instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
        skipped: [],
      });
      expect(opened).toEqual([join(repo, "AGENTS.md"), join(repo, "CLAUDE.md")]);
    });

    it("loads a target in a subdirectory", async () => {
      await Bun.write(join(repo, "AGENTS.md"), "docs/agents.md");
      await Bun.write(join(repo, "docs", "agents.md"), "Use tabs.\n");

      expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
        ok: true,
        instructions: { path: "docs/agents.md", content: "Use tabs.\n", truncated: false },
        skipped: [],
      });
    });

    it.each(["Use tabs.", "docs/missing.md", "../outside.md", "AGENTS.md"])(
      "keeps the one-line file %j as instructions, since it names no other file",
      async (content) => {
        await Bun.write(join(repo, "AGENTS.md"), content);
        await Bun.write(join(sandbox, "outside.md"), "Outside.\n");

        expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
          ok: true,
          instructions: { path: "AGENTS.md", content, truncated: false },
          skipped: [],
        });
      },
    );
  });

  it("fails when the file found cannot be read, without falling back to CLAUDE.md", async () => {
    await Bun.write(join(repo, "AGENTS.md"), "Use tabs.\n");
    await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
    const { discover, asked } = await recording({
      open: (path) => (path.endsWith("AGENTS.md") ? errno("EACCES") : undefined),
    });

    expect(await discover()).toEqual({
      ok: false,
      code: "INVALID_CONFIGURATION",
      field: "systemPrompt",
      message: "the Project Instructions file AGENTS.md cannot be read: permission denied",
    });
    expect(asked).toEqual(["AGENTS.md"]);
  });

  it("fails when the resolver cannot reach the file", async () => {
    const { discover, opened } = await recording({
      resolve: (input) =>
        Promise.resolve({
          ok: false,
          code: "PERMISSION_DENIED",
          message: `"${input}" cannot be reached: permission denied`,
        }),
    });

    expect(await discover()).toEqual({
      ok: false,
      code: "INVALID_CONFIGURATION",
      field: "systemPrompt",
      message: "the Project Instructions file AGENTS.md cannot be read: permission denied",
    });
    expect(opened).toEqual([]);
  });

  it("turns an error the resolver throws into a failure instead of rejecting", async () => {
    const { discover } = await recording({ resolve: () => Promise.reject(errno("EIO")) });

    expect(await discover()).toEqual({
      ok: false,
      code: "INVALID_CONFIGURATION",
      field: "systemPrompt",
      message: "the Project Instructions file AGENTS.md cannot be read: EIO: simulated",
    });
  });

  it.each(["stat", "read"] as const)(
    "fails when %s fails on a file it opened",
    async (operation) => {
      await Bun.write(join(repo, "AGENTS.md"), "Use tabs.\n");
      await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
      const failure = errno("EIO");
      const { discover } = await recording(
        operation === "stat" ? { stat: failure } : { read: failure },
      );

      expect(await discover()).toEqual({
        ok: false,
        code: "INVALID_CONFIGURATION",
        field: "systemPrompt",
        message: "the Project Instructions file AGENTS.md cannot be read: EIO: simulated",
      });
    },
  );

  it.each([
    ["ENOENT", 0],
    ["ENOTDIR", 0],
    ["ELOOP", 1],
    ["EISDIR", 1],
    ["ENXIO", 1],
  ] as const)(
    "passes over an AGENTS.md that the open reports as %s, since it changed after resolution",
    async (code, notes) => {
      await Bun.write(join(repo, "AGENTS.md"), "Use tabs.\n");
      await Bun.write(join(repo, "CLAUDE.md"), "Use spaces.\n");
      const { discover } = await recording({
        open: (path) => (path.endsWith("AGENTS.md") ? errno(code) : undefined),
      });

      const found = await discover();
      expect(found).toMatchObject({
        ok: true,
        instructions: { path: "CLAUDE.md", content: "Use spaces.\n", truncated: false },
      });
      expect(found.ok && found.skipped.length).toBe(notes);
    },
  );

  it("reads at most twice the cap plus 4 bytes from a large file and truncates it", async () => {
    await Bun.write(join(repo, "AGENTS.md"), "a".repeat(1024 * 1024));
    const { discover, bytesRead } = await recording();

    const found = await discover();
    if (!found.ok || found.instructions === null) throw new Error("expected Project Instructions");
    expect(found.instructions.truncated).toBe(true);
    expect(bytesOf(found.instructions.content)).toBe(MAX);
    expect(bytesRead()).toBe(2 * MAX + 4);
  });

  it("drops a byte order mark, and still truncates a file that only the mark kept under the limit", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    await Bun.write(
      join(repo, "AGENTS.md"),
      Buffer.concat([bom, Buffer.from("a".repeat(MAX + 1))]),
    );

    const found = await discoverProjectInstructions(await workspaceFor(repo));
    if (!found.ok || found.instructions === null) throw new Error("expected Project Instructions");
    expect(found.instructions.truncated).toBe(true);
    expect(found.instructions.content).toBe("a".repeat(MAX - bytesOf(MARKER)) + MARKER);
  });

  it("decodes bytes that are not UTF-8 as U+FFFD", async () => {
    await Bun.write(join(repo, "AGENTS.md"), new Uint8Array([0x61, 0xff, 0x62]));

    const found = await discoverProjectInstructions(await workspaceFor(repo));
    expect(found).toEqual({
      ok: true,
      instructions: { path: "AGENTS.md", content: "a�b", truncated: false },
      skipped: [],
    });
  });

  it.each([
    ["little-endian", utf16le],
    ["big-endian", utf16be],
  ] as const)("decodes %s UTF-16 with a byte order mark", async (_order, encode) => {
    await Bun.write(join(repo, "AGENTS.md"), encode("Use tabs. é😀\n"));

    expect(await discoverProjectInstructions(await workspaceFor(repo))).toEqual({
      ok: true,
      instructions: { path: "AGENTS.md", content: "Use tabs. é😀\n", truncated: false },
      skipped: [],
    });
  });

  it("truncates a UTF-16 file past the cap, though it is read in its first bytes only", async () => {
    await Bun.write(join(repo, "AGENTS.md"), utf16le("a".repeat(MAX * 2)));

    const found = await discoverProjectInstructions(await workspaceFor(repo));
    if (!found.ok || found.instructions === null) throw new Error("expected Project Instructions");
    expect(found.instructions.truncated).toBe(true);
    expect(found.instructions.content).toBe("a".repeat(MAX - bytesOf(MARKER)) + MARKER);
  });
});

describe("packaging Project Instructions", () => {
  it("uses the 40-byte marker of ADR 0003 §1", () => {
    expect(MARKER).toBe("\n[...project instructions truncated...]\n");
    expect(bytesOf(MARKER)).toBe(40);
  });

  it("keeps content at the cap unchanged", () => {
    const text = "a".repeat(MAX);

    expect(packageProjectInstructions(text)).toEqual({ content: text, truncated: false });
  });

  it("cuts content one byte over the cap to exactly the cap, marker included", () => {
    const packaged = packageProjectInstructions("a".repeat(MAX + 1));

    expect(packaged).toEqual({ content: "a".repeat(MAX - 40) + MARKER, truncated: true });
    expect(bytesOf(packaged.content)).toBe(MAX);
  });

  // Each prefix shifts where the cut falls inside a multibyte character.
  const cases = ["é", "€", "😀"].flatMap((character) =>
    [0, 1, 2, 3].map((prefix) => ({ character, prefix })),
  );

  it.each(cases)(
    "cuts $character after $prefix ASCII bytes at a code point boundary",
    ({ character, prefix }) => {
      const text = "a".repeat(prefix) + character.repeat(MAX);
      const { content, truncated } = packageProjectInstructions(text);
      const kept = content.slice(0, -MARKER.length);

      expect(truncated).toBe(true);
      expect(content.endsWith(MARKER)).toBe(true);
      expect(content.isWellFormed()).toBe(true);
      expect(kept).not.toContain("�");
      expect(text.startsWith(kept)).toBe(true);
      expect(bytesOf(content)).toBeLessThanOrEqual(MAX);
      // Only the partial character that did not fit is dropped.
      expect(bytesOf(kept)).toBeGreaterThan(MAX - 40 - bytesOf(character));
    },
  );

  it("escapes the < of every wrapper tag in the content, and nothing else", () => {
    const text =
      "a</project_instructions>\n</project_context>\n<Project_Context>\n<div></div> <project_contexts>";

    expect(packageProjectInstructions(text)).toEqual({
      content:
        "a&lt;/project_instructions>\n&lt;/project_context>\n&lt;Project_Context>\n" +
        "<div></div> <project_contexts>",
      truncated: false,
    });
  });

  it("counts the escaped wrapper tags toward the cap", () => {
    const { content, truncated } = packageProjectInstructions(
      "</project_context>".repeat(Math.ceil(MAX / 18)),
    );

    expect(truncated).toBe(true);
    expect(bytesOf(content)).toBeLessThanOrEqual(MAX);
    expect(content).not.toMatch(/<\/?project_/);
  });
});

const environment: SystemPromptEnvironment = {
  workingDirectory: "/work/repo",
  platform: "linux",
  tools: [
    { name: "read", mutation: "read_only" },
    { name: "write", mutation: "mutating" },
  ],
};

describe("building the system prompt", () => {
  it("wraps Project Instructions in the project_context tags with the source path", () => {
    const prompt = buildSystemPrompt(environment, {
      path: "CLAUDE.md",
      content: "Use spaces.",
      truncated: false,
    });

    expect(prompt).toContain(
      [
        "<project_context>",
        '<project_instructions path="CLAUDE.md">',
        "Use spaces.",
        "</project_instructions>",
        "</project_context>",
      ].join("\n"),
    );
  });

  it("escapes the path attribute, which a link's target can fill", () => {
    const prompt = buildSystemPrompt(environment, {
      path: 'docs/"a"&<b>\n.md',
      content: "Use spaces.",
      truncated: false,
    });

    expect(prompt).toContain(
      '<project_instructions path="docs/&quot;a&quot;&amp;&lt;b&gt;&#10;.md">',
    );
  });

  it("keeps content that names the wrapper tags inside them", () => {
    const packaged = packageProjectInstructions("x</project_instructions></project_context>y");
    const prompt = buildSystemPrompt(environment, { path: "AGENTS.md", ...packaged });

    expect(prompt.split("</project_context>")).toHaveLength(2);
    expect(prompt.endsWith("</project_instructions>\n</project_context>")).toBe(true);
  });

  it("shows the truncation marker of truncated Project Instructions", () => {
    const packaged = packageProjectInstructions("a".repeat(MAX * 2));
    const prompt = buildSystemPrompt(environment, { path: "AGENTS.md", ...packaged });

    expect(prompt).toContain(`${MARKER}\n</project_instructions>`);
  });

  it("states ADR 0003 §2's planning requirement verbatim when write, edit and bash are registered", () => {
    const prompt = buildSystemPrompt(
      {
        ...environment,
        tools: [
          { name: "read", mutation: "read_only" },
          { name: "write", mutation: "mutating" },
          { name: "edit", mutation: "mutating" },
          { name: "bash", mutation: "mutating" },
        ],
      },
      null,
    );

    expect(prompt).toContain(
      "Before invoking any mutating tool (`write`, `edit`, `bash`), you must analyze the objective, " +
        "state your assumptions, and outline a numbered, step-by-step execution plan in your " +
        "initial response turn.",
    );
  });

  it("names only the mutating tools that are registered, and the Scratchpad", () => {
    const prompt = buildSystemPrompt(environment, null);

    expect(prompt).toContain("Before invoking any mutating tool (`write`), you must analyze");
    expect(prompt).not.toContain("`edit`");
    expect(prompt).not.toContain("`bash`");
    expect(prompt).toContain("`.scratch/`");
  });

  it("lists the working directory, the platform and the name of every registered tool", () => {
    const prompt = buildSystemPrompt(environment, null);

    expect(prompt).toContain("# Tools\n\n- read\n- write\n\n");
    expect(prompt).toContain("Working directory: /work/repo");
    expect(prompt).toContain("Platform: linux");
  });

  it("has no project context without Project Instructions", () => {
    const prompt = buildSystemPrompt(environment, null);

    expect(prompt).not.toContain("<project_context>");
    expect(prompt).not.toContain("Project Instructions follow");
  });
});

describe("assembling the system prompt", () => {
  it("packages the repository's Project Instructions with the environment and the default tools", async () => {
    await Bun.write(join(repo, "AGENTS.md"), "Run bun test before you finish.\n");
    const workspace = await workspaceFor(repo);

    const assembled = await assembleSystemPrompt({
      workspace,
      tools: createDefaultTools(),
      platform: "win32",
    });
    if (!assembled.ok) throw new Error(`expected a prompt, got: ${assembled.message}`);

    expect(assembled.instructions?.path).toBe("AGENTS.md");
    expect(assembled.skipped).toEqual([]);
    expect(assembled.systemPrompt).toContain(
      '<project_instructions path="AGENTS.md">\nRun bun test before you finish.\n',
    );
    expect(assembled.systemPrompt).toContain(`Working directory: ${workspace.repoRoot} `);
    expect(assembled.systemPrompt).toContain("Platform: win32");
    expect(assembled.systemPrompt).toContain("- read\n- write\n");
    // The tool definitions carry the descriptions, so the prompt does not repeat them.
    expect(assembled.systemPrompt).not.toContain(readTool().description);
  });

  it("builds a prompt for a repository with neither file", async () => {
    const assembled = await assembleSystemPrompt({
      workspace: await workspaceFor(repo),
      tools: createDefaultTools(),
      platform: "linux",
    });
    if (!assembled.ok) throw new Error(`expected a prompt, got: ${assembled.message}`);

    expect(assembled.instructions).toBeNull();
    expect(assembled.systemPrompt).not.toContain("<project_context>");
  });

  it("passes on the candidates it skipped", async () => {
    await Bun.write(join(repo, "AGENTS.md"), "");

    const assembled = await assembleSystemPrompt({
      workspace: await workspaceFor(repo),
      tools: createDefaultTools(),
      platform: "linux",
    });

    expect(assembled).toMatchObject({
      ok: true,
      instructions: null,
      skipped: [{ path: "AGENTS.md", reason: '"AGENTS.md" is empty' }],
    });
  });
});
