import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoPath } from "@coding-agent/agent-core";
import { createChildProcessLauncher, createWorkspaceResolver } from "../src/index.ts";
import {
  combinedOutputArgv,
  runSupervised,
  type SupervisedExit,
  timeoutProblem,
} from "../src/process-run.ts";
import { findShell, processShellHost } from "../src/shell.ts";
import { noPosixSignals } from "./platform.ts";

let repo: string;
let repoRoot: RepoPath;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "process-run-")));
  const created = await createWorkspaceResolver(repo);
  if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
  repoRoot = created.workspace.repoRoot;
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const launcher = (() => {
  const configured = createChildProcessLauncher(["CDA74_PROVIDER_KEY"]);
  if (!configured.ok) throw new Error(configured.message);
  return configured.launcher;
})();

const shell = (() => {
  const found = findShell(processShellHost());
  if (!found.ok) throw new Error(found.message);
  return found.shell;
})();

interface Supervised {
  readonly exit: SupervisedExit;
  readonly output: string;
  readonly elapsedMs: number;
}

async function supervise(
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Supervised> {
  let output = "";
  const started = performance.now();
  const exit = await runSupervised(launcher, {
    argv: combinedOutputArgv(shell, command),
    cwd: repoRoot,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal ?? new AbortController().signal,
    onOutput: (_chunk, text) => {
      output += text;
    },
  });
  return { exit, output, elapsedMs: performance.now() - started };
}

describe("supervising a command", () => {
  it("reports the exit code of a command that ends on its own, with no stop reason", async () => {
    const { exit, output } = await supervise("echo hello; exit 3");

    expect(exit).toEqual({ exitCode: 3, signalCode: null });
    expect(output).toBe("hello\n");
  });

  it("delivers stdout and stderr through one pipe, in the order they were written", async () => {
    const { output } = await supervise("echo one; echo two >&2; echo three");

    expect(output).toBe("one\ntwo\nthree\n");
  });

  it("stops a command at its timeout and says the timeout stopped it", async () => {
    const { exit, output, elapsedMs } = await supervise("echo started; sleep 10", {
      timeoutMs: 300,
    });

    expect(exit.stopReason).toBe("timeout");
    expect(output).toBe("started\n");
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it("stops a command when the signal aborts and says cancellation stopped it", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const { exit, elapsedMs } = await supervise("sleep 10", { signal: controller.signal });

    expect(exit.stopReason).toBe("cancelled");
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it("stops a command at once when the signal had already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { exit, elapsedMs } = await supervise("sleep 10", { signal: controller.signal });

    expect(exit.stopReason).toBe("cancelled");
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it.skipIf(noPosixSignals)(
    "reports a signal the supervisor did not send without a stop reason",
    async () => {
      const { exit } = await supervise("kill -KILL $$");

      expect(exit).toEqual({ exitCode: null, signalCode: "SIGKILL" });
    },
  );
});

describe("the shared timeout bounds", () => {
  it("accepts a whole number of milliseconds from 1 to 120,000 and explains anything else", () => {
    expect(timeoutProblem(1)).toBeUndefined();
    expect(timeoutProblem(120_000)).toBeUndefined();
    for (const timeoutMs of [0, 1.5, 120_001, Number.NaN]) {
      expect(timeoutProblem(timeoutMs)).toBe(
        "timeoutMs must be a whole number of milliseconds from 1 to 120000",
      );
    }
  });
});
