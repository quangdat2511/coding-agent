import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runnerChainIsClean } from "./support/ancestor-chain.ts";
import { parsedRun } from "./support/parsed-run.ts";
import {
  bunLikeShebang as bun,
  firstLine,
  runProcess,
  withTemporaryDirectory,
} from "./support/process.ts";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const forcePtraceDrop = join(import.meta.dir, "support", "force-ptrace-drop.ts");
const failAncestorCheck = join(import.meta.dir, "support", "fail-ancestor-check.ts");
const cleanChain = await runnerChainIsClean();

const credential = { ANTHROPIC_API_KEY: "sk-test-credential-value" };

const remains = {
  ok: false,
  code: "CAPABILITY_REMAINS",
  message: "CAP_SYS_PTRACE is still in the bounding set after the drop, forced by the test",
};
const failed = {
  ok: false,
  code: "DROP_FAILED",
  message:
    "cannot drop CAP_SYS_PTRACE, so no child can be started safely: capset failed: forced by the test",
};

// ptrace-capability.ts is replaced in the child, so this runs on every platform.
function runWith(
  forced: unknown,
  args: readonly string[],
  preloads: readonly string[] = [forcePtraceDrop],
) {
  return withTemporaryDirectory(async (directory) => {
    await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");
    const flags = preloads.flatMap((preload) => ["--preload", preload]);
    const result = await runProcess([...bun, ...flags, cli, ...args], {
      cwd: directory,
      env: { ...credential, FORCED_PTRACE_DROP: JSON.stringify(forced) },
    });
    return { ...result, files: await readdir(directory) };
  });
}

describe("the coding-agent executable when CAP_SYS_PTRACE cannot be dropped", () => {
  it.skipIf(!cleanChain)("exits 2 with the message when the capability remains", async () => {
    const { exitCode, stdout, stderr, files } = await runWith(remains, parsedRun);

    expect(firstLine(stderr)).toBe(`coding-agent: ${remains.message}`);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    // A resolved configuration would have created the output directory.
    expect(files).toEqual(["task.md"]);
  });

  it.skipIf(!cleanChain)("exits 70 with the cause when a call fails", async () => {
    const { exitCode, stdout, stderr, files } = await runWith(failed, parsedRun);

    expect(firstLine(stderr)).toBe(`coding-agent: ${failed.message}`);
    expect(exitCode).toBe(70);
    expect(stdout).toBe("");
    expect(files).toEqual(["task.md"]);
  });

  it("checks the ancestors before it drops the capability", async () => {
    // The check reads each ancestor's environment as this process can. Dropping first would leave it
    // reading as the child can, and on Modal a root launcher that holds the capability would be
    // passed over instead of refused. Both stubs fail here; the first message tells which ran first.
    const { exitCode, stderr } = await runWith(failed, parsedRun, [
      failAncestorCheck,
      forcePtraceDrop,
    ]);

    expect(firstLine(stderr)).toBe("coding-agent: forced by the test");
    expect(exitCode).toBe(70);
  });

  it("still exits 2 on a usage error, which is decided before the drop", async () => {
    const { exitCode, stderr } = await runWith(failed, ["run", "--nope"]);

    expect(firstLine(stderr)).toBe('coding-agent: unknown flag "--nope"');
    expect(exitCode).toBe(2);
  });

  it("skips the ancestor check and the drop under ask", async () => {
    const { exitCode, stderr } = await runWith(
      failed,
      ["--provider", "anthropic", "--model", "claude-haiku-4-5"],
      [failAncestorCheck, forcePtraceDrop],
    );

    // A test runner has no terminal, so the interactive path stops there after both checks would
    // have refused under auto-approve.
    expect(exitCode).toBe(2);
    expect(firstLine(stderr)).toBe(
      "coding-agent: the interactive path needs a terminal on standard input and output; use `coding-agent run` for a task without one",
    );
  });
});
