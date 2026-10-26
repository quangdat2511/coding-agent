import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");

const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
  bin?: Record<string, string>;
};

const declared = manifest.bin?.["coding-agent"];
if (declared === undefined) throw new Error("package.json declares no coding-agent bin entry");

const bin = join(packageRoot, declared);

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

const windows = process.platform === "win32";

// Children get only the variables the runtime needs plus what a test adds, so a developer's own
// provider keys never decide whether a credential is present.
const systemEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
if (windows) {
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]) {
    const value = process.env[name];
    if (value !== undefined) systemEnv[name] = value;
  }
}

async function run(args: readonly string[], cwd = packageRoot, env: Record<string, string> = {}) {
  // Windows cannot execute the shebang script directly; run it through Bun and keep the env-file
  // isolation the shebang asks for.
  const command = windows ? [process.execPath, "--no-env-file", bin, ...args] : [bin, ...args];
  const child = Bun.spawn(command, {
    cwd,
    env: { ...systemEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const firstLine = (stderr: string): string => (stderr.split("\n")[0] ?? "").replace(/\r$/, "");

async function withTemporaryDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-cli-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

interface ConfigurationErrorCase {
  readonly name: string;
  readonly flags?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly expected: string;
}

describe("the coding-agent executable", () => {
  it("declares a bin entry whose shebang disables Bun's autoload", async () => {
    expect(existsSync(bin)).toBe(true);
    if (!windows) expect(statSync(bin).mode & 0o111).not.toBe(0);
    const source = await Bun.file(bin).text();
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null");
  });

  // A shebang is not used on Windows, so the config it names cannot be applied there.
  it.skipIf(windows)("ignores a bunfig.toml preload in the working directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      await Bun.write(join(directory, "preload.ts"), 'process.stderr.write("preloaded\\n");\n');

      const { exitCode, stderr } = await run(["run", "--nope"], directory);
      expect(exitCode).toBe(2);
      expect(stderr).not.toContain("preloaded");
    });
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

  it.each<ConfigurationErrorCase>([
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

  // Temporary: CDA-67 (Join 2) opens the Agent Session, and CDA-75 (D3.1) and CDA-78 (D3.2)
  // replace exit 70 with the real exit codes. Nothing should come to depend on 70.
  it("exits 70 once the configuration resolves, because the run itself is not implemented yet", async () => {
    await withTemporaryDirectory(async (directory) => {
      await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");
      const { exitCode, stdout, stderr } = await run(validRun(), directory, {
        ANTHROPIC_API_KEY: secret,
      });

      expect(exitCode).toBe(70);
      expect(stderr).toContain("CDA-67");
      expect(stdout + stderr).not.toContain(secret);
      // The output directory is the one thing a resolved configuration writes.
      expect((await readdir(directory)).sort()).toEqual(["out", "task.md"]);
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  });

  // Temporary: CDA-79 (D3.3) gives terminalbench its limits. Until then it is not a configuration
  // error, so it must not exit 2, which Harbor reads as an invalid invocation.
  it("exits 70 on --profile terminalbench without leaving an output directory behind", async () => {
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
  });

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
