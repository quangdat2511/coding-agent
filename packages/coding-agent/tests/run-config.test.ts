import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunArgs } from "../src/run-args.ts";
import { resolveRunConfig } from "../src/run-config.ts";

const secret = "sk-test-credential-value";

// Permission checks cannot fail for root, which CI containers may run as.
const asRoot = process.getuid?.() === 0;

let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "coding-agent-config-")));
  await mkdir(join(directory, "repo"));
  await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const argsWith = (overrides: Partial<RunArgs> = {}): RunArgs => ({
  taskFile: "task.md",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  approvalPolicy: "auto-approve",
  outputDir: "out",
  profile: "default",
  repoRoot: "repo",
  ...overrides,
});

const resolveWith = (
  overrides: Partial<RunArgs> = {},
  env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: secret },
) => resolveRunConfig(argsWith(overrides), { cwd: directory, env });

const refusal = (field: string, message: string) => ({
  ok: false as const,
  code: "INVALID_CONFIGURATION" as const,
  field,
  message,
});

// A refused configuration writes nothing: the output directory is created only once every check
// has passed.
async function expectRefused(
  resolved: Awaited<ReturnType<typeof resolveWith>>,
  field: string,
  message: string,
) {
  expect(resolved).toStrictEqual(refusal(field, message));
  expect((await readdir(directory)).sort()).toEqual(["repo", "task.md"]);
}

describe("resolving a valid invocation", () => {
  it("resolves the model, paths, task, limits and Verification configuration", async () => {
    const resolved = await resolveWith();
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);

    const { config } = resolved;
    expect(config.model.provider).toBe("anthropic");
    expect(config.model.id).toBe("claude-haiku-4-5");
    expect(config.objective).toBe("Add a failing test, then make it pass.\n");
    expect(config.taskFile).toBe(join(directory, "task.md"));
    expect(config.repoRoot).toBe(join(directory, "repo"));
    expect(config.outputDir).toBe(join(directory, "out"));
    expect(config.approvalPolicy).toBe("auto-approve");
    expect(config.profile).toBe("default");
    expect(config.limits).toEqual({
      maxModelTurns: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxConsecutiveRecoverableFailures: 3,
      cancellationGraceMs: 5_000,
    });
    expect(config.verification).toEqual({ command: null });
    expect(config.credential.variable).toBe("ANTHROPIC_API_KEY");
    expect(config.credential.reveal()).toBe(secret);
  });
});

describe("selecting the provider and model", () => {
  it("refuses a model the provider directory does not list for a known provider", async () => {
    await expectRefused(
      await resolveWith({ model: "claude-sonnet-4" }),
      "--model",
      '--model "claude-sonnet-4" is not a known anthropic model',
    );
  });
});

describe("reading the provider credential", () => {
  it("refuses a run whose provider credential variable is blank", async () => {
    await expectRefused(
      await resolveWith({}, { ANTHROPIC_API_KEY: " \t", OPENAI_API_KEY: secret }),
      "ANTHROPIC_API_KEY",
      "no credential for --provider anthropic: set ANTHROPIC_API_KEY",
    );
  });

  it("names every variable a provider reads when none of them is set", async () => {
    await expectRefused(
      await resolveWith({ provider: "google", model: "gemini-2.5-flash" }, {}),
      "GOOGLE_API_KEY",
      "no credential for --provider google: set GOOGLE_API_KEY or GEMINI_API_KEY",
    );
  });

  it("keeps the credential value out of every serialized or inspected form of the configuration", async () => {
    const resolved = await resolveWith();
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(JSON.stringify(resolved.config)).not.toContain(secret);
    expect(JSON.stringify(resolved.config)).toContain(
      '"credential":{"variable":"ANTHROPIC_API_KEY"}',
    );
    expect(Bun.inspect(resolved.config)).not.toContain(secret);
    expect(String(resolved.config.credential)).not.toContain(secret);
  });

  it("reads the variables a provider declares in order, so Google falls back to GEMINI_API_KEY", async () => {
    const resolved = await resolveWith(
      { provider: "google", model: "gemini-2.5-flash" },
      { GEMINI_API_KEY: secret },
    );
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.credential.variable).toBe("GEMINI_API_KEY");
    expect(resolved.config.credential.reveal()).toBe(secret);
  });
});

describe("configuring the verification command", () => {
  it("takes the verification command verbatim from CODING_AGENT_VERIFICATION_COMMAND", async () => {
    const resolved = await resolveWith(
      {},
      { ANTHROPIC_API_KEY: secret, CODING_AGENT_VERIFICATION_COMMAND: "bun test --bail" },
    );
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.verification).toEqual({ command: "bun test --bail" });
  });

  it.each(["", "  \t"])(
    "refuses a verification command that is set but blank (%p)",
    async (blank) => {
      await expectRefused(
        await resolveWith(
          {},
          { ANTHROPIC_API_KEY: secret, CODING_AGENT_VERIFICATION_COMMAND: blank },
        ),
        "CODING_AGENT_VERIFICATION_COMMAND",
        "CODING_AGENT_VERIFICATION_COMMAND is set but blank; unset it to configure no command",
      );
    },
  );
});

describe("resolving the repository root", () => {
  it("resolves a relative root against the working directory to its canonical path", async () => {
    await symlink(join(directory, "repo"), join(directory, "link"));
    const resolved = await resolveWith({ repoRoot: "link" });
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.repoRoot).toBe(join(directory, "repo"));
  });

  it("refuses a root that does not exist", async () => {
    await expectRefused(
      await resolveWith({ repoRoot: "missing" }),
      "--repo-root",
      '--repo-root "missing" does not exist',
    );
  });

  it("refuses a root that is not a directory", async () => {
    await expectRefused(
      await resolveWith({ repoRoot: "task.md" }),
      "--repo-root",
      '--repo-root "task.md" is not a directory',
    );
  });

  it.skipIf(asRoot)("refuses a root that cannot be listed", async () => {
    await chmod(join(directory, "repo"), 0o300);
    try {
      await expectRefused(
        await resolveWith(),
        "--repo-root",
        '--repo-root "repo" cannot be read: permission denied',
      );
    } finally {
      await chmod(join(directory, "repo"), 0o755);
    }
  });
});

describe("reading the task file", () => {
  it.each([
    { name: "a missing file", taskFile: "missing.md", expected: "does not exist" },
    { name: "a directory", taskFile: "repo", expected: "is a directory" },
  ])("refuses $name", async ({ taskFile, expected }) => {
    await expectRefused(
      await resolveWith({ taskFile }),
      "--task-file",
      `--task-file "${taskFile}" ${expected}`,
    );
  });

  it.each([
    {
      name: "invalid UTF-8",
      content: new Uint8Array([0x66, 0x69, 0x78, 0xff]),
      expected: "is not valid UTF-8",
    },
    { name: "an empty file", content: "", expected: "is blank" },
    { name: "a whitespace-only file", content: " \n\t\n", expected: "is blank" },
  ])("refuses $name", async ({ content, expected }) => {
    await Bun.write(join(directory, "task.md"), content);
    await expectRefused(await resolveWith(), "--task-file", `--task-file "task.md" ${expected}`);
  });

  it("refuses a named pipe instead of waiting for a writer", async () => {
    Bun.spawnSync(["mkfifo", join(directory, "pipe")]);
    expect(await resolveWith({ taskFile: "pipe" })).toStrictEqual(
      refusal("--task-file", '--task-file "pipe" is not a regular file'),
    );
  });

  it.skipIf(asRoot)("refuses a file that cannot be read", async () => {
    await chmod(join(directory, "task.md"), 0o000);
    await expectRefused(
      await resolveWith(),
      "--task-file",
      '--task-file "task.md" cannot be read: permission denied',
    );
  });
});

describe("preparing the output directory", () => {
  it("creates a missing output directory and its parents", async () => {
    const resolved = await resolveWith({ outputDir: "logs/agent/coding-agent" });
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.outputDir).toBe(join(directory, "logs/agent/coding-agent"));
    expect(await readdir(resolved.config.outputDir)).toEqual([]);
  });

  it("accepts an existing output directory and leaves its contents alone", async () => {
    await Bun.write(join(directory, "out", "notes.txt"), "kept");
    const resolved = await resolveWith();
    expect(resolved.ok).toBe(true);
    expect(await Bun.file(join(directory, "out", "notes.txt")).text()).toBe("kept");
  });

  it.each([
    { name: "a file", outputDir: "task.md", expected: "is not a directory" },
    {
      name: "a path below a file",
      outputDir: "task.md/out",
      expected: "cannot be created: a parent is not a directory",
    },
  ])("refuses an output directory that is $name", async ({ outputDir, expected }) => {
    await expectRefused(
      await resolveWith({ outputDir }),
      "--output-dir",
      `--output-dir "${outputDir}" ${expected}`,
    );
  });

  it.skipIf(asRoot)("refuses an output directory that cannot be created", async () => {
    await mkdir(join(directory, "locked"), { mode: 0o555 });
    expect(await resolveWith({ outputDir: "locked/out" })).toStrictEqual(
      refusal("--output-dir", '--output-dir "locked/out" cannot be created: permission denied'),
    );
  });

  it.skipIf(asRoot)("refuses an existing output directory that is not writable", async () => {
    await mkdir(join(directory, "out"), { mode: 0o555 });
    expect(await resolveWith()).toStrictEqual(
      refusal("--output-dir", '--output-dir "out" is not writable'),
    );
  });
});

// Temporary: CDA-79 (D3.3) resolves terminalbench to the ADR 0005 §5 limits.
describe("selecting the terminalbench profile before its limits exist", () => {
  it("reports the profile as not implemented once every configuration check has passed", async () => {
    expect(await resolveWith({ profile: "terminalbench" })).toStrictEqual({
      ok: false,
      code: "NOT_IMPLEMENTED",
      field: "--profile",
      message: "--profile terminalbench is not implemented yet; CDA-79 (D3.3) adds its limits",
    });
  });

  it("still refuses a configuration error first", async () => {
    await expectRefused(
      await resolveWith({ profile: "terminalbench", model: "claude-sonnet-4" }),
      "--model",
      '--model "claude-sonnet-4" is not a known anthropic model',
    );
  });
});
