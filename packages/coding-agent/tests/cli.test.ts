import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { runnerChainIsClean } from "./support/ancestor-chain.ts";
import { NAMED_TASK_FILE, NAMED_TASK_REPO, READ_ONLY_RUN } from "./support/named-task.ts";
import { noModeBits, noSignalHandlers, onWindows } from "./support/platform.ts";
import {
  bunLikeShebang,
  firstLine,
  runProcess,
  startProcess,
  withTemporaryDirectory,
  writePreloadingBunfig,
} from "./support/process.ts";
import { withoutProfile } from "./support/profile.ts";
import { HANG_QUIESCE_MS_ENV_VAR, REPLAY_FIXTURES_ENV_VAR } from "./support/recorded-provider.ts";

// A run that gets past argument parsing meets the ancestor check first.
const cleanChain = await runnerChainIsClean();

const packageRoot = join(import.meta.dir, "..");

const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
  version: string;
  bin?: Record<string, string>;
};

const declared = manifest.bin?.["coding-agent"];
if (declared === undefined) throw new Error("package.json declares no coding-agent bin entry");

const bin = join(packageRoot, declared);

const replayProvider = join(import.meta.dir, "support", "replay-provider.ts");
const hangProvider = join(import.meta.dir, "support", "hang-provider.ts");
const failSessionFactory = join(import.meta.dir, "support", "fail-session-factory.ts");
const hangSessionFactory = join(import.meta.dir, "support", "hang-session-factory.ts");

// Windows cannot start a file by its shebang or mode bits, so there the bin runs under this Bun.
const command = onWindows ? [...bunLikeShebang, bin] : [bin];

// The autoload flags of ADR 0005 §2, built for this host rather than the evaluation targets.
async function compileExecutable(
  directory: string,
  extraFlags: readonly string[] = [],
): Promise<string[]> {
  const outfile = join(directory, onWindows ? "coding-agent.exe" : "coding-agent");
  const build = await runProcess([
    process.execPath,
    "build",
    bin,
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...extraFlags,
    "--outfile",
    outfile,
  ]);
  if (build.exitCode !== 0) throw new Error(`bun build --compile failed:\n${build.stderr}`);
  return [outfile];
}

const launchPaths = [
  ...(onWindows ? [] : [{ name: "the bin entry", launch: async () => [bin] }]),
  { name: "the compiled executable", launch: compileExecutable },
];

const required = [
  "--task-file",
  "/tmp/task.md",
  "--provider",
  "anthropic",
  "--model",
  "claude-haiku-4-5",
  "--approval-policy",
  "auto-approve",
  "--output-dir",
  "/tmp/out",
];

const secret = "sk-test-credential-value";

const run = (args: readonly string[], cwd = packageRoot, env: Record<string, string> = {}) =>
  runProcess([...command, ...args], { cwd, env });

// Relative paths, resolved against the working directory each test runs in.
const validFlags = {
  "--task-file": "task.md",
  "--provider": "anthropic",
  "--model": "claude-haiku-4-5",
  "--approval-policy": "auto-approve",
  "--output-dir": "out",
};

const validRun = (overrides: Record<string, string> = {}): string[] => [
  "run",
  ...Object.entries({ ...validFlags, ...overrides }).flat(),
];

const namedTaskRun = validRun({
  "--task-file": NAMED_TASK_FILE,
  "--provider": READ_ONLY_RUN.provider,
  "--model": READ_ONLY_RUN.model,
  "--repo-root": "repo",
});

// The preload injects the replayed responses, so the arguments after `bin` are the real command line.
const replayedNamedTask = [...bunLikeShebang, "--preload", replayProvider, bin, ...namedTaskRun];

const hangingNamedTask = [...bunLikeShebang, "--preload", hangProvider, bin, ...namedTaskRun];

const replayEnv = (fixtures: readonly string[]): Record<string, string> => ({
  GOOGLE_API_KEY: secret,
  [REPLAY_FIXTURES_ENV_VAR]: fixtures.join(","),
});

const runFiles = ["events.jsonl", "result.json", "run.json"];

// Only a line that ends in a newline is a whole event.
async function eventTypes(outputDir: string): Promise<unknown[]> {
  const log = Bun.file(join(outputDir, "events.jsonl"));
  const lines = (await log.exists()) ? (await log.text()).split("\n").slice(0, -1) : [];
  return lines.map((line) => JSON.parse(line).type);
}

const lastEventType = async (outputDir: string) => (await eventTypes(outputDir)).at(-1);

async function untilLogged(outputDir: string, type: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await eventTypes(outputDir)).includes(type)) return;
    await Bun.sleep(10);
  }
  throw new Error(`no ${type} event was logged`);
}

async function untilExists(path: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`${path} was never created`);
}

interface ConfigurationErrorCase {
  readonly name: string;
  readonly flags?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly expected: string;
}

type HangingRun = { run: ReturnType<typeof startProcess>; outputDir: string };

// The child outlives a failed expectation unless it is killed: its Model Turn never ends by itself.
async function withHangingModelTurn(
  quiesceMs: string,
  body: (hanging: HangingRun) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
    const outputDir = join(directory, "out");
    const run = startProcess(hangingNamedTask, {
      cwd: directory,
      env: { GOOGLE_API_KEY: secret, [HANG_QUIESCE_MS_ENV_VAR]: quiesceMs },
    });
    try {
      await untilLogged(outputDir, "model_turn_started");
      await body({ run, outputDir });
    } finally {
      run.signal("SIGKILL");
    }
  });
}

describe("the coding-agent executable", () => {
  it("is declared as a bin entry whose shebang disables Bun's autoload", async () => {
    expect(existsSync(bin)).toBe(true);
    const source = await Bun.file(bin).text();
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null");
  });

  it.skipIf(noModeBits)("marks the bin entry executable", () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  it("sees a bunfig.toml preload in the working directory when Bun autoloads it", async () => {
    await withTemporaryDirectory(async (directory) => {
      await writePreloadingBunfig(directory);

      const { stderr } = await runProcess([process.execPath, bin, "run", "--nope"], {
        cwd: directory,
      });
      expect(stderr).toContain("preloaded");
    });
  });

  // Bun's Windows bin shim cannot start an `env -S` shebang and Bun there accepts no spelling of
  // an empty device as --config, so on Windows the compiled executable is the only launch path.
  it.each(launchPaths)(
    "ignores a bunfig.toml preload in the working directory, launched as $name",
    async ({ launch }) => {
      await withTemporaryDirectory(async (directory) => {
        await writePreloadingBunfig(directory);

        const command = await launch(directory);
        const { exitCode, stderr } = await runProcess([...command, "run", "--nope"], {
          cwd: directory,
        });
        expect(stderr).not.toContain("preloaded");
        expect(exitCode).toBe(2);
      });
    },
    60_000,
  );

  it.skipIf(!cleanChain).each(launchPaths)(
    "ignores a .env credential in the working directory, launched as $name",
    async ({ launch }) => {
      await withTemporaryDirectory(async (directory) => {
        await Bun.write(join(directory, ".env"), `ANTHROPIC_API_KEY=${secret}\n`);
        await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");

        const command = await launch(directory);
        const { exitCode, stderr } = await runProcess([...command, ...validRun()], {
          cwd: directory,
        });
        expect(firstLine(stderr)).toBe(
          "coding-agent: no credential for --provider anthropic: set ANTHROPIC_API_KEY",
        );
        expect(exitCode).toBe(2);
      });
    },
    60_000,
  );

  it.each(launchPaths)(
    "prints the version and no commit for a build without one, launched as $name",
    async ({ launch }) => {
      await withTemporaryDirectory(async (directory) => {
        const command = await launch(directory);
        const result = await runProcess([...command, "--version"], { cwd: directory });
        expect(result).toMatchObject({
          exitCode: 0,
          stdout: `coding-agent ${manifest.version} (no commit)\n`,
          stderr: "",
        });
      });
    },
    60_000,
  );

  it("prints the commit that the build defines with --version", async () => {
    await withTemporaryDirectory(async (directory) => {
      const command = await compileExecutable(directory, [
        "--define",
        'CODING_AGENT_COMMIT="0123abc"',
      ]);
      const result = await runProcess([...command, "--version"], { cwd: directory });
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: `coding-agent ${manifest.version} 0123abc\n`,
        stderr: "",
      });
    });
  }, 60_000);

  it("treats --version after another argument as a usage error", async () => {
    const { exitCode, stderr } = await run(["run", "--version"]);
    expect(firstLine(stderr)).toBe('coding-agent: unknown flag "--version"');
    expect(exitCode).toBe(2);
  });

  it.each([
    { name: "no arguments", args: [], expected: "a command is required" },
    {
      name: "a missing --task-file",
      args: ["run", ...required.slice(2)],
      expected: "--task-file is required",
    },
    {
      name: "a missing --approval-policy",
      args: ["run", ...required.slice(0, 6), ...required.slice(8)],
      expected: "--approval-policy is required",
    },
    {
      name: "an unknown flag",
      args: ["run", ...required, "--nope"],
      expected: 'unknown flag "--nope"',
    },
    {
      name: "an unknown provider",
      args: ["run", ...required.slice(0, 2), ...required.slice(4), "--provider", "mistral"],
      expected:
        '--provider must be one of anthropic, openrouter, openai, google, xai, opencode, not "mistral"',
    },
    {
      name: "an approval policy of ask",
      args: ["run", ...required.slice(0, 6), "--approval-policy", "ask", ...required.slice(8)],
      expected: '--approval-policy must be "auto-approve", not "ask"',
    },
    {
      name: "an unknown profile",
      args: ["run", ...required, "--profile", "fast"],
      expected: '--profile must be one of default, terminalbench, not "fast"',
    },
  ] satisfies { name: string; args: string[]; expected: string }[])(
    "exits 2 and writes a usage message to standard error on $name",
    async ({ args, expected }) => {
      const { exitCode, stdout, stderr } = await run(args);
      expect(exitCode).toBe(2);
      expect(firstLine(stderr)).toBe(`coding-agent: ${expected}`);
      expect(stderr).toContain("usage: coding-agent run");
      expect(stdout).toBe("");
    },
  );

  it.skipIf(!cleanChain).each<ConfigurationErrorCase>([
    {
      name: "an unknown model",
      flags: { "--model": "no-such-model" },
      expected: '--model "no-such-model" is not a known anthropic model',
    },
    {
      name: "an unknown opencode model",
      flags: { "--provider": "opencode", "--model": "no-such-model" },
      env: { OPENCODE_API_KEY: secret },
      expected: '--model "no-such-model" is not a known opencode model',
    },
    {
      name: "a missing credential",
      env: {},
      expected: "no credential for --provider anthropic: set ANTHROPIC_API_KEY",
    },
    {
      name: "a blank verification command",
      env: { ANTHROPIC_API_KEY: secret, CODING_AGENT_VERIFICATION_COMMAND: " " },
      expected:
        "CODING_AGENT_VERIFICATION_COMMAND is set but blank; unset it to configure no command",
    },
    {
      name: "an invalid repository root",
      flags: { "--repo-root": "missing" },
      expected: '--repo-root "missing" does not exist',
    },
    {
      name: "an unreadable task file",
      flags: { "--task-file": "missing.md" },
      expected: '--task-file "missing.md" does not exist',
    },
    {
      name: "an unusable output directory",
      flags: { "--output-dir": "task.md" },
      expected: '--output-dir "task.md" is not a directory',
    },
  ])(
    "exits 2 on $name without writing anything or printing the credential",
    async ({ flags = {}, env = { ANTHROPIC_API_KEY: secret }, expected }) => {
      await withTemporaryDirectory(async (directory) => {
        await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");
        const { exitCode, stdout, stderr } = await run(validRun(flags), directory, env);

        expect(exitCode).toBe(2);
        expect(firstLine(stderr)).toBe(`coding-agent: ${expected}`);
        expect(stdout).toBe("");
        expect(stderr).not.toContain(secret);
        expect(await readdir(directory)).toEqual(["task.md"]);
      });
    },
  );

  it.skipIf(!cleanChain)(
    "exits 0 on the named task against recorded Google responses and writes the three files",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        const { exitCode, stdout, stderr } = await runProcess(replayedNamedTask, {
          cwd: directory,
          env: replayEnv(READ_ONLY_RUN.fixtures),
        });

        expect(stderr).toBe("coding-agent: succeeded; workspace changed: no\n");
        expect(exitCode).toBe(0);
        expect(stdout).toStartWith("I have read `src/slugify.ts`.");
        expect(stdout).not.toContain(secret);
        expect((await readdir(directory)).sort()).toEqual(["out", "repo"]);

        const outputDir = join(directory, "out");
        expect((await readdir(outputDir)).sort()).toEqual(runFiles);
        expect(await Bun.file(join(outputDir, "run.json")).json()).toMatchObject({
          schemaVersion: 1,
          codingAgent: { commit: null },
          profile: "default",
          tools: ["read"],
        });
        expect(await lastEventType(outputDir)).toBe("session_settled");
        expect(await Bun.file(join(outputDir, "result.json")).json()).toMatchObject({
          schemaVersion: 1,
          exitCode: 0,
          result: { outcome: "succeeded" },
        });
      });
    },
  );

  it.skipIf(!cleanChain)(
    "exits 1 when a replayed response ends at the output token limit and writes the three files",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        const { exitCode, stdout, stderr } = await runProcess(replayedNamedTask, {
          cwd: directory,
          env: replayEnv(["google/finish-reason-max-tokens.txt"]),
        });

        expect(firstLine(stderr)).toBe("coding-agent: failed; workspace changed: no");
        expect(stderr).toContain("coding-agent: MODEL_FAILURE: ");
        expect(exitCode).toBe(1);
        expect(stdout + stderr).not.toContain(secret);

        const outputDir = join(directory, "out");
        expect((await readdir(outputDir)).sort()).toEqual(runFiles);
        expect(await lastEventType(outputDir)).toBe("session_settled");
        expect(await Bun.file(join(outputDir, "result.json")).json()).toMatchObject({
          schemaVersion: 1,
          exitCode: 1,
          result: { outcome: "failed", failure: { code: "MODEL_FAILURE" } },
        });
      });
    },
  );

  it.skipIf(!cleanChain)(
    "exits 70 before the first Model Turn when the event log cannot be opened",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        const outputDir = join(directory, "out");
        await mkdir(join(outputDir, "events.jsonl"), { recursive: true });
        const { exitCode, stdout, stderr } = await runProcess(replayedNamedTask, {
          cwd: directory,
          env: replayEnv(READ_ONLY_RUN.fixtures),
        });

        expect(firstLine(stderr)).toStartWith("coding-agent: internal error: ");
        expect(exitCode).toBe(70);
        expect(stdout).toBe("");
        expect(stderr).not.toContain(secret);
        expect(await readdir(outputDir)).toEqual(["events.jsonl"]);
      });
    },
  );

  it.skipIf(!cleanChain)("records the commit that the build defines in run.json", async () => {
    await withTemporaryDirectory(async (directory) => {
      await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
      const [bun = "", ...flags] = replayedNamedTask;
      const { exitCode } = await runProcess(
        [bun, "--define", 'CODING_AGENT_COMMIT="0123abc"', ...flags],
        { cwd: directory, env: replayEnv(READ_ONLY_RUN.fixtures) },
      );

      expect(exitCode).toBe(0);
      const run = await Bun.file(join(directory, "out", "run.json")).json();
      expect(run.codingAgent.commit).toBe("0123abc");
    });
  });

  // A shell pipeline is the simplest way to close the reading end before the run prints, and Windows
  // reports a closed pipe differently, so this is POSIX only. The shell stays alive as an ancestor,
  // so it must not receive the key in its environment, or the ancestor check refuses the run. A
  // script file reads the key from another file and exports it. That keeps the key out of the
  // shell's /proc environ, and keeps the assignment out of its arguments, which the check also reads.
  it.skipIf(onWindows || !cleanChain)(
    "exits 0 on a succeeded run after the reader of its standard output has gone",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        await Bun.write(join(directory, "key"), secret);
        await Bun.write(
          join(directory, "launch.sh"),
          'GOOGLE_API_KEY="$(cat key)"\nexport GOOGLE_API_KEY\n("$@"; echo "exit $?" >&2) | true\n',
        );
        const { stderr } = await runProcess(["sh", "launch.sh", ...replayedNamedTask], {
          cwd: directory,
          env: { [REPLAY_FIXTURES_ENV_VAR]: READ_ONLY_RUN.fixtures.join(",") },
        });

        expect(stderr).toBe("coding-agent: succeeded; workspace changed: no\nexit 0\n");
      });
    },
  );

  it.skipIf(!cleanChain)(
    "exits 70 without the credential or an output directory when the session factory throws",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        const { exitCode, stdout, stderr } = await runProcess(
          [...bunLikeShebang, "--preload", failSessionFactory, bin, ...namedTaskRun],
          { cwd: directory, env: { GOOGLE_API_KEY: secret } },
        );

        expect(exitCode).toBe(70);
        expect(stdout).toBe("");
        expect(stderr).toBe("coding-agent: internal error: forced by the test, key [redacted]\n");
        expect(await readdir(directory)).toEqual(["repo"]);
      });
    },
  );

  // Both runs use the same directory, so repoRoot and every other recorded value can match.
  it.skipIf(!cleanChain)(
    "exits 0 under --profile terminalbench and records a run.json that differs only in its limits",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        const runUnder = async (profile: string) => {
          const { exitCode, stderr } = await runProcess(
            [...replayedNamedTask, "--profile", profile],
            { cwd: directory, env: replayEnv(READ_ONLY_RUN.fixtures) },
          );
          expect(stderr).toBe("coding-agent: succeeded; workspace changed: no\n");
          expect(exitCode).toBe(0);
          const outputDir = join(directory, `out-${profile}`);
          await rename(join(directory, "out"), outputDir);
          expect((await readdir(outputDir)).sort()).toEqual(runFiles);
          return Bun.file(join(outputDir, "run.json")).json();
        };
        const standard = await runUnder("default");
        const terminalbench = await runUnder("terminalbench");

        expect(standard).toMatchObject({ profile: "default", limits: { maxModelTurns: 30 } });
        expect(terminalbench).toMatchObject({
          profile: "terminalbench",
          limits: {
            maxModelTurns: 250,
            maxToolCalls: 1_000,
            maxDurationMs: 3_600_000,
            maxConsecutiveRecoverableFailures: 10,
            cancellationGraceMs: standard.limits.cancellationGraceMs,
          },
        });
        expect(withoutProfile(terminalbench)).toStrictEqual(withoutProfile(standard));
      });
    },
  );

  it.skipIf(noSignalHandlers || !cleanChain).each(["SIGINT", "SIGTERM"] as const)(
    "exits 130 on %s during a Model Turn and writes the three files",
    async (signal) => {
      await withHangingModelTurn("0", async ({ run, outputDir }) => {
        run.signal(signal);
        const { exitCode, killedBy, stdout, stderr } = await run.finished;

        expect(stderr).toBe("coding-agent: cancelled; workspace changed: no\n");
        expect(killedBy).toBeNull();
        expect(exitCode).toBe(130);
        expect(stdout).toBe("");
        expect((await readdir(outputDir)).sort()).toEqual(runFiles);
        expect(await lastEventType(outputDir)).toBe("session_settled");
        expect(await Bun.file(join(outputDir, "result.json")).json()).toMatchObject({
          schemaVersion: 1,
          exitCode: 130,
          result: {
            outcome: "cancelled",
            cancellation: { reason: signal },
            workspaceChanged: false,
            partialChangesPossible: false,
          },
        });
      });
    },
  );

  it.skipIf(noSignalHandlers || !cleanChain)(
    "settles cancelled once and exits 130 when a second signal arrives while cancelling",
    async () => {
      await withHangingModelTurn("2000", async ({ run, outputDir }) => {
        run.signal("SIGINT");
        await untilLogged(outputDir, "cancellation_requested");
        expect(await eventTypes(outputDir)).not.toContain("session_settled");
        run.signal("SIGTERM");
        const { exitCode, killedBy, stderr } = await run.finished;

        expect(stderr).toBe("coding-agent: cancelled; workspace changed: no\n");
        expect(killedBy).toBeNull();
        expect(exitCode).toBe(130);
        expect((await readdir(outputDir)).sort()).toEqual(runFiles);
        const types = await eventTypes(outputDir);
        expect(types.filter((type) => type === "cancellation_requested")).toHaveLength(1);
        expect(types.at(-1)).toBe("session_settled");
        expect(await Bun.file(join(outputDir, "result.json")).json()).toMatchObject({
          exitCode: 130,
          result: { outcome: "cancelled", cancellation: { reason: "SIGINT" } },
        });
      });
    },
  );

  it.skipIf(noSignalHandlers || !cleanChain).each([
    ["SIGINT", "SIGTERM"],
    ["SIGTERM", "SIGINT"],
  ] as const)(
    "ignores %s and is ended by %s when no Agent Session has opened",
    async (first, second) => {
      await withTemporaryDirectory(async (directory) => {
        await cp(NAMED_TASK_REPO, join(directory, "repo"), { recursive: true });
        const run = startProcess(
          [...bunLikeShebang, "--preload", hangSessionFactory, bin, ...namedTaskRun],
          { cwd: directory, env: { GOOGLE_API_KEY: secret } },
        );
        try {
          // The output directory exists once the configuration resolves, just before openSession.
          await untilExists(join(directory, "out"));
          run.signal(first);
          const outcome = await Promise.race([run.finished, Bun.sleep(300).then(() => "running")]);
          expect(outcome).toBe("running");
          run.signal(second);
          const { killedBy, stdout, stderr } = await run.finished;

          expect(killedBy).toBe(second);
          expect(stdout).toBe("");
          expect(stderr).toBe("");
        } finally {
          run.signal("SIGKILL");
        }
      });
    },
  );

  // The default profile's Cancellation Grace Period is 5,000 ms.
  it.skipIf(noSignalHandlers || !cleanChain)(
    "exits 1 with CANCELLATION_TIMEOUT and the three files when the Model Turn ignores the cancellation",
    async () => {
      await withHangingModelTurn("Infinity", async ({ run, outputDir }) => {
        run.signal("SIGTERM");
        const { exitCode, killedBy, stderr } = await run.finished;

        expect(firstLine(stderr)).toBe("coding-agent: failed; workspace changed: no");
        expect(stderr).toContain("coding-agent: CANCELLATION_TIMEOUT: ");
        expect(killedBy).toBeNull();
        expect(exitCode).toBe(1);
        expect((await readdir(outputDir)).sort()).toEqual(runFiles);
        expect(await lastEventType(outputDir)).toBe("session_settled");
        expect(await Bun.file(join(outputDir, "result.json")).json()).toMatchObject({
          schemaVersion: 1,
          exitCode: 1,
          result: {
            outcome: "failed",
            failure: { code: "CANCELLATION_TIMEOUT" },
            workspaceChanged: false,
            partialChangesPossible: false,
          },
        });
      });
    },
    20_000,
  );

  it("writes nothing before it refuses a usage error", async () => {
    await withTemporaryDirectory(async (directory) => {
      const refused = await run(
        ["run", "--output-dir", "out", "--provider", "anthropic"],
        directory,
        { ANTHROPIC_API_KEY: secret },
      );

      expect(refused.exitCode).toBe(2);
      expect(await readdir(directory)).toEqual([]);
    });
  });
});
