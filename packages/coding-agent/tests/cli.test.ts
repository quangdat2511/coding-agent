import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
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

/** Runs the declared bin entry the way a checkout does, and reads both streams to completion. */
async function run(args: readonly string[], cwd = packageRoot) {
  const child = Bun.spawn([process.execPath, bin, ...args], {
    cwd,
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

describe("the coding-agent executable", () => {
  it("is declared as a bin entry and runs from a checkout", async () => {
    expect(existsSync(bin)).toBe(true);
    const source = await Bun.file(bin).text();
    expect(source.startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  it.each([
    { name: "no arguments", args: [], expected: "usage" },
    {
      name: "a missing required flag",
      args: ["run", ...required.slice(2)],
      expected: "--task-file",
    },
    { name: "an unknown flag", args: ["run", ...required, "--nope"], expected: "--nope" },
    {
      name: "an unknown provider",
      args: ["run", ...required.slice(2), "--task-file", "/tmp/t.md", "--provider", "mistral"],
      expected: "--provider",
    },
    {
      name: "an approval policy of ask",
      args: ["run", ...required.slice(0, 6), "--approval-policy", "ask", ...required.slice(8)],
      expected: "--approval-policy",
    },
    {
      name: "an unknown profile",
      args: ["run", ...required, "--profile", "fast"],
      expected: "--profile",
    },
  ] satisfies { name: string; args: string[]; expected: string }[])(
    "exits 2 and writes a usage message to standard error on $name",
    async ({ args, expected }) => {
      const { exitCode, stdout, stderr } = await run(args);
      expect(exitCode).toBe(2);
      expect(stderr).toContain(expected);
      expect(stderr).toContain("usage");
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
    const directory = await mkdtemp(join(tmpdir(), "coding-agent-cli-"));
    try {
      const outputDir = join(directory, "out");
      const taskFile = join(directory, "task.md");
      const refused = await run(["run", "--output-dir", outputDir, "--provider", "anthropic"]);
      const deferred = await run([
        "run",
        "--task-file",
        taskFile,
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4",
        "--approval-policy",
        "auto-approve",
        "--output-dir",
        outputDir,
      ]);

      expect(refused.exitCode).toBe(2);
      expect(deferred.exitCode).toBe(70);
      // The output directory is never created and the unreadable task file is never opened:
      // creating one and reading the other is CDA-59's work, not this ticket's.
      expect(existsSync(outputDir)).toBe(false);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
