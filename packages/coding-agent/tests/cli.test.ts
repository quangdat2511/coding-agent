import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runnerChainIsClean } from "./support/ancestor-chain.ts";
import { NAMED_TASK_FILE, NAMED_TASK_REPO, READ_ONLY_RUN } from "./support/named-task.ts";
import { noModeBits, onWindows } from "./support/platform.ts";
import {
  bunLikeShebang,
  firstLine,
  runProcess,
  withTemporaryDirectory,
} from "./support/process.ts";
import { REPLAY_FIXTURES_ENV_VAR } from "./support/recorded-provider.ts";

// A run that gets past argument parsing meets the ancestor check first.
const cleanChain = await runnerChainIsClean();

const packageRoot = join(import.meta.dir, "..");

const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
  bin?: Record<string, string>;
};

const declared = manifest.bin?.["coding-agent"];
if (declared === undefined) throw new Error("package.json declares no coding-agent bin entry");

const bin = join(packageRoot, declared);

const replayProvider = join(import.meta.dir, "support", "replay-provider.ts");
const failSessionFactory = join(import.meta.dir, "support", "fail-session-factory.ts");

// Windows cannot start a file by its shebang or mode bits, so there the bin runs under this Bun.
const command = onWindows ? [...bunLikeShebang, bin] : [bin];

// The autoload flags of ADR 0005 §2, built for this host rather than the evaluation targets.
async function compileExecutable(directory: string): Promise<string[]> {
  const outfile = join(directory, onWindows ? "coding-agent.exe" : "coding-agent");
  const build = await runProcess([
    process.execPath,
    "build",
    bin,
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    outfile,
  ]);
  if (build.exitCode !== 0) throw new Error(`bun build --compile failed:\n${build.stderr}`);
  return [outfile];
}

async function writePreloadingBunfig(directory: string): Promise<void> {
  await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await Bun.write(join(directory, "preload.ts"), 'process.stderr.write("preloaded\\n");\n');
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

const replayEnv = (fixtures: readonly string[]): Record<string, string> => ({
  GOOGLE_API_KEY: secret,
  [REPLAY_FIXTURES_ENV_VAR]: fixtures.join(","),
});

const runFiles = ["events.jsonl", "result.json", "run.json"];

async function lastEventType(outputDir: string): Promise<unknown> {
  const lines = (await Bun.file(join(outputDir, "events.jsonl")).text()).trimEnd().split("\n");
  return JSON.parse(lines.at(-1) ?? "{}").type;
}

interface ConfigurationErrorCase {
  readonly name: string;
  readonly flags?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly expected: string;
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
        '--provider must be one of anthropic, openrouter, openai, google, xai, not "mistral"',
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

  // Temporary: CDA-79 (D3.3) gives terminalbench its limits. Until then it is not a configuration
  // error, so it must not exit 2, which Harbor reads as an invalid invocation.
  it.skipIf(!cleanChain)(
    "exits 70 on --profile terminalbench without leaving an output directory behind",
    async () => {
      await withTemporaryDirectory(async (directory) => {
        await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");
        const { exitCode, stdout, stderr } = await run(
          validRun({ "--profile": "terminalbench" }),
          directory,
          { ANTHROPIC_API_KEY: secret },
        );

        expect(exitCode).toBe(70);
        expect(firstLine(stderr)).toBe(
          "coding-agent: --profile terminalbench is not implemented yet; CDA-79 (D3.3) adds its limits",
        );
        expect(stdout).toBe("");
        expect(await readdir(directory)).toEqual(["task.md"]);
      });
    },
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
