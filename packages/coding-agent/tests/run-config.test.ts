import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunArgs } from "../src/run-args.ts";
import {
  MAX_TASK_FILE_BYTES,
  parentIsFile,
  RUN_LIMITS_BY_PROFILE,
  type RunConfig,
  resolveAgentRunSettings,
  resolveRunConfig,
} from "../src/run-config.ts";
import { noFifos, permissionsIgnored } from "./support/platform.ts";
import { withoutProfile } from "./support/profile.ts";

const secret = "sk-test-credential-value";

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

describe("resolving the settings every entry point shares", () => {
  const selection = { provider: "anthropic", model: "claude-haiku-4-5", repoRoot: "repo" } as const;
  const env = { ANTHROPIC_API_KEY: secret };

  it("resolves the model, credential and repository without a task file or output directory", async () => {
    const resolved = await resolveAgentRunSettings(selection, { cwd: directory, env });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.model.id).toBe("claude-haiku-4-5");
    expect(resolved.value.repoRoot).toBe(join(directory, "repo"));
    expect(resolved.value.credential.reveal()).toBe(secret);
    expect(resolved.value.verification).toEqual({ command: null });
    expect(await readdir(directory)).not.toContain("out");
  });

  it("refuses a model the provider does not list, as the invocation does", async () => {
    const resolved = await resolveAgentRunSettings(
      { ...selection, model: "no-such-model" },
      { cwd: directory, env },
    );

    expect(resolved).toEqual(
      refusal("--model", '--model "no-such-model" is not a known anthropic model'),
    );
  });
});

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
    expect(config.givenRepoRoot).toBe(join(directory, "repo"));
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

describe("choosing the model settings", () => {
  const providerDefaults = { maxOutputTokens: null, temperature: null };

  it.each([
    [
      "anthropic",
      "claude-haiku-4-5",
      "ANTHROPIC_API_KEY",
      { ...providerDefaults, maxOutputTokens: 32_000 },
    ],
    ["google", "gemini-2.5-flash", "GOOGLE_API_KEY", providerDefaults],
    ["openai", "gpt-4o-mini", "OPENAI_API_KEY", providerDefaults],
    ["openrouter", "openai/gpt-4o-mini", "OPENROUTER_API_KEY", providerDefaults],
    ["xai", "grok-4.3", "XAI_API_KEY", providerDefaults],
    ["opencode", "deepseek-v4.1-flash", "OPENCODE_API_KEY", providerDefaults],
  ] as const)(
    "records the sampling settings %s runs with",
    async (provider, model, variable, sampling) => {
      const resolved = await resolveWith({ provider, model }, { [variable]: secret });
      if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
      expect(JSON.parse(JSON.stringify(resolved.config)).sampling).toEqual(sampling);
    },
  );

  it("records a transport retry bound of 2", async () => {
    const resolved = await resolveWith();
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(JSON.parse(JSON.stringify(resolved.config)).transportRetryBound).toBe(2);
  });
});

describe("selecting the provider and model", () => {
  it("refuses a model the provider directory does not list for a known provider", async () => {
    await expectRefused(
      await resolveWith({ model: "no-such-model" }),
      "--model",
      '--model "no-such-model" is not a known anthropic model',
    );
  });

  it("refuses a model id absent from the opencode catalogue, which the CLI reports as exit 2", async () => {
    await expectRefused(
      await resolveWith(
        { provider: "opencode", model: "no-such-model" },
        { OPENCODE_API_KEY: secret },
      ),
      "--model",
      '--model "no-such-model" is not a known opencode model',
    );
  });

  it("resolves the opencode model the recorded job runs, with the credential it reads", async () => {
    const resolved = await resolveWith(
      { provider: "opencode", model: "deepseek-v4.1-flash" },
      { OPENCODE_API_KEY: secret },
    );
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.model).toMatchObject({
      provider: "opencode",
      id: "deepseek-v4.1-flash",
    });
    expect(resolved.config.credential.variable).toBe("OPENCODE_API_KEY");
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

  it("skips a blank variable the way the provider adapters do, so Google falls back to GEMINI_API_KEY", async () => {
    const resolved = await resolveWith(
      { provider: "google", model: "gemini-2.5-flash" },
      { GOOGLE_API_KEY: " ", GEMINI_API_KEY: secret },
    );
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.credential.variable).toBe("GEMINI_API_KEY");
  });

  it("trims the credential, so a CRLF env file still yields a usable key", async () => {
    const resolved = await resolveWith({}, { ANTHROPIC_API_KEY: ` ${secret}\r\n` });
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
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
    expect(resolved.config.givenRepoRoot).toBe(join(directory, "link"));
  });

  it("names the working directory when --repo-root was omitted", async () => {
    const gone = join(directory, "gone");
    expect(
      await resolveRunConfig(argsWith({ repoRoot: gone }), {
        cwd: gone,
        env: { ANTHROPIC_API_KEY: secret },
      }),
    ).toStrictEqual(
      refusal(
        "--repo-root",
        `the working directory "${gone}" (the default --repo-root) does not exist`,
      ),
    );
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

  it.skipIf(permissionsIgnored)("refuses a root that cannot be listed", async () => {
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

  it.skipIf(permissionsIgnored)("refuses a root that is not writable", async () => {
    await chmod(join(directory, "repo"), 0o555);
    try {
      await expectRefused(await resolveWith(), "--repo-root", '--repo-root "repo" is not writable');
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
    {
      name: "a file larger than the limit",
      content: "x".repeat(MAX_TASK_FILE_BYTES + 1),
      expected: "is larger than 1 MiB",
    },
  ])("refuses $name", async ({ content, expected }) => {
    await Bun.write(join(directory, "task.md"), content);
    await expectRefused(await resolveWith(), "--task-file", `--task-file "task.md" ${expected}`);
  });

  it("accepts a task file of exactly the limit", async () => {
    await Bun.write(join(directory, "task.md"), "x".repeat(MAX_TASK_FILE_BYTES));
    const resolved = await resolveWith();
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    expect(resolved.config.objective).toHaveLength(MAX_TASK_FILE_BYTES);
  });

  it.skipIf(noFifos)("refuses a named pipe instead of waiting for a writer", async () => {
    expect(Bun.spawnSync(["mkfifo", join(directory, "pipe")]).exitCode).toBe(0);
    expect(await resolveWith({ taskFile: "pipe" })).toStrictEqual(
      refusal("--task-file", '--task-file "pipe" is not a regular file'),
    );
  });

  it.skipIf(permissionsIgnored)("refuses a file that cannot be read", async () => {
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

  it.skipIf(permissionsIgnored)("refuses an output directory that cannot be created", async () => {
    await mkdir(join(directory, "locked"), { mode: 0o555 });
    expect(await resolveWith({ outputDir: "locked/out" })).toStrictEqual(
      refusal("--output-dir", '--output-dir "locked/out" cannot be created: permission denied'),
    );
  });

  it.skipIf(permissionsIgnored)(
    "refuses an existing output directory that is not writable",
    async () => {
      await mkdir(join(directory, "out"), { mode: 0o555 });
      expect(await resolveWith()).toStrictEqual(
        refusal("--output-dir", '--output-dir "out" is not writable'),
      );
    },
  );

  // A umask that drops the owner's write bit creates directories this run cannot write into.
  describe.skipIf(permissionsIgnored)("under a umask that makes new directories read-only", () => {
    let previous: number;
    beforeEach(() => {
      previous = process.umask(0o222);
    });
    afterEach(() => {
      process.umask(previous);
    });

    it.each([
      { name: "it created but cannot write", outputDir: "out", expected: "is not writable" },
      {
        name: "it only partly created",
        outputDir: "logs/agent/out",
        expected: "cannot be created: permission denied",
      },
    ])("removes an output directory $name", async ({ outputDir, expected }) => {
      await expectRefused(
        await resolveWith({ outputDir }),
        "--output-dir",
        `--output-dir "${outputDir}" ${expected}`,
      );
    });

    it("removes only what it created, leaving a parent that already existed as it was", async () => {
      const logs = join(directory, "logs");
      await mkdir(logs);
      await chmod(logs, 0o755);
      expect(await resolveWith({ outputDir: "logs/agent/out" })).toStrictEqual(
        refusal(
          "--output-dir",
          '--output-dir "logs/agent/out" cannot be created: permission denied',
        ),
      );
      expect(await readdir(logs)).toEqual([]);
      expect((await stat(logs)).mode & 0o777).toBe(0o755);
    });
  });

  // mkdir reports EEXIST for a name something else already holds, so nothing is recorded as this
  // run's, and nothing of the other owner's is removed.
  it("refuses a dangling symbolic link and leaves it in place", async () => {
    await symlink(join(directory, "nowhere"), join(directory, "out"));
    expect(await resolveWith()).toStrictEqual(
      refusal("--output-dir", '--output-dir "out" is not a directory'),
    );
    expect((await lstat(join(directory, "out"))).isSymbolicLink()).toBe(true);
  });
});

describe("classifying a missing output parent", () => {
  it("finds the first existing ancestor and reports whether it is a file", async () => {
    const calls: string[] = [];
    const statPath = async (path: string) => {
      calls.push(path);
      if (path === join("root", "file", "missing")) {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      if (path === join("root", "file")) return { isDirectory: () => false };
      return { isDirectory: () => true };
    };

    expect(await parentIsFile(join("root", "file", "missing", "out"), statPath)).toBe(true);
    expect(calls).toEqual([join("root", "file", "missing"), join("root", "file")]);
  });

  it("returns false when the first existing ancestor is a directory", async () => {
    const statPath = async () => ({ isDirectory: () => true });

    expect(await parentIsFile(join("root", "out"), statPath)).toBe(false);
  });

  it("returns false when no ancestor exists", async () => {
    const statPath = async () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    };

    expect(await parentIsFile(join("/", "missing", "out"), statPath)).toBe(false);
  });
});

describe("resolving an Evaluation Profile", () => {
  async function resolveProfile(profile: RunArgs["profile"]): Promise<RunConfig> {
    const resolved = await resolveWith({ profile });
    if (!resolved.ok) throw new Error(`expected a configuration, got: ${resolved.message}`);
    return resolved.config;
  }

  // The credential is a closure, so it is compared by what it reveals.
  const comparable = (config: RunConfig) => {
    const { credential, ...rest } = withoutProfile(config);
    return { ...rest, credential: { variable: credential.variable, value: credential.reveal() } };
  };

  // The same object, not an equal one: nothing computes a limit at run time, so neither a flag nor
  // an environment variable can change it.
  it("resolves terminalbench to the source-controlled ADR 0005 §5 limits", async () => {
    const config = await resolveProfile("terminalbench");

    expect(config.profile).toBe("terminalbench");
    expect(config.limits).toBe(RUN_LIMITS_BY_PROFILE.terminalbench);
    expect(config.limits).toEqual({
      maxModelTurns: 250,
      maxToolCalls: 1_000,
      maxDurationMs: 3_600_000,
      maxConsecutiveRecoverableFailures: 10,
      cancellationGraceMs: RUN_LIMITS_BY_PROFILE.default.cancellationGraceMs,
    });
  });

  it("changes nothing other than RunLimits", async () => {
    const standard = await resolveProfile("default");
    const terminalbench = await resolveProfile("terminalbench");

    expect(standard.limits).toBe(RUN_LIMITS_BY_PROFILE.default);
    expect(terminalbench.limits).not.toEqual(standard.limits);
    expect(comparable(terminalbench)).toStrictEqual(comparable(standard));
  });

  it("freezes the source-controlled limits", () => {
    expect(Object.isFrozen(RUN_LIMITS_BY_PROFILE)).toBe(true);
    expect(Object.isFrozen(RUN_LIMITS_BY_PROFILE.default)).toBe(true);
    expect(Object.isFrozen(RUN_LIMITS_BY_PROFILE.terminalbench)).toBe(true);
  });
});
