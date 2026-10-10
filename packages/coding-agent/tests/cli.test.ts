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
  "claude-sonnet-4",
  "--approval-policy",
  "auto-approve",
  "--output-dir",
  "/tmp/out",
];

/** Executes the declared bin entry through its shebang, and reads both streams to completion. */
async function run(args: readonly string[], cwd = packageRoot) {
  const child = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** The diagnostic line itself; every usage error also prints USAGE, which names every flag. */
const firstLine = (stderr: string): string => stderr.split("\n")[0] ?? "";

async function withTemporaryDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-cli-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("the coding-agent executable", () => {
  it("is declared as an executable bin entry that runs from a checkout", () => {
    expect(existsSync(bin)).toBe(true);
    expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  it("ignores .env and bunfig.toml in the working directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      await Bun.write(join(directory, "preload.ts"), 'process.stderr.write("preloaded\\n");\n');
      await Bun.write(join(directory, ".env"), "CODING_AGENT_DOTENV_PROBE=loaded\n");

      const { exitCode, stderr } = await run(["run", "--nope"], directory);
      expect(exitCode).toBe(2);
      expect(stderr).not.toContain("preloaded");
    });
    const source = await Bun.file(bin).text();
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null");
  });

  it.each([
    { name: "no arguments", args: [], expected: "a command is required" },
    {
      name: "a missing required flag",
      args: ["run", ...required.slice(2)],
      expected: "--task-file is required",
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

  // Temporary: CDA-59 (D1.2) replaces this with a resolved configuration, and CDA-75 (D3.1)
  // replaces exit 70 with the real exit codes. Nothing should come to depend on 70 here.
  it("exits 70 on a valid invocation, because the run itself is not implemented yet", async () => {
    const { exitCode, stderr } = await run(["run", ...required]);
    expect(exitCode).toBe(70);
    expect(stderr).toContain("CDA-59");
  });

  it("writes nothing and opens no Agent Session before it refuses or defers", async () => {
    // The working directory is the temporary directory, so a write relative to it (the default
    // repository root, or the relative paths below) would show up in the listing.
    await withTemporaryDirectory(async (directory) => {
      const refused = await run(
        ["run", "--output-dir", "out", "--provider", "anthropic"],
        directory,
      );
      const deferred = await run(
        [
          "run",
          "--task-file",
          "task.md",
          "--provider",
          "anthropic",
          "--model",
          "claude-sonnet-4",
          "--approval-policy",
          "auto-approve",
          "--output-dir",
          "out",
        ],
        directory,
      );

      expect(refused.exitCode).toBe(2);
      expect(deferred.exitCode).toBe(70);
      // The output directory is never created and the unreadable task file is never opened:
      // creating one and reading the other is CDA-59's work, not this ticket's.
      expect(await readdir(directory)).toEqual([]);
    });
  });
});
