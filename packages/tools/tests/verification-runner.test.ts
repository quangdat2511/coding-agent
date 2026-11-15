import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceResolver } from "@coding-agent/agent-core";
import {
  createChildProcessLauncher,
  createVerificationRunner,
  createWorkspaceResolver,
  type VerificationRunnerOptions,
  type VerificationRunnerResult,
} from "../src/index.ts";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";
import { createVerificationRunnerOn } from "../src/verification-runner.ts";
import { noPosixSignals } from "./platform.ts";

let sandbox: string;
let repo: string;
let workspace: WorkspaceResolver;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "verification-runner-")));
  repo = join(sandbox, "repo");
  await mkdir(repo);
  const created = await createWorkspaceResolver(repo);
  if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
  workspace = created.workspace;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

const launcher = (() => {
  const configured = createChildProcessLauncher(["CDA74_PROVIDER_KEY"]);
  if (!configured.ok) throw new Error(configured.message);
  return configured.launcher;
})();

function runnerWith(options: Partial<VerificationRunnerOptions> = {}) {
  const created = createVerificationRunner({ launcher, workspace, ...options });
  if (!created.ok) throw new Error(created.message);
  return created.runner;
}

async function verify(
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VerificationRunnerResult> {
  const runner = runnerWith(
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  return runner.run(command, { signal: options.signal ?? new AbortController().signal });
}

// durationMs is measured, so tests compare everything else exactly and the duration on its own.
function withoutDuration(result: VerificationRunnerResult) {
  const { durationMs, ...rest } = result;
  expect(durationMs).toBeGreaterThanOrEqual(0);
  return rest;
}

describe("running the verification command", () => {
  it("reports a command that exits 0 as completed", async () => {
    expect(withoutDuration(await verify("echo ok"))).toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    });
  });

  it("reports a failing command as completed with its exit code and both streams in order", async () => {
    expect(withoutDuration(await verify("echo out; echo err >&2; exit 1"))).toEqual({
      status: "completed",
      exitCode: 1,
      stdout: "out\nerr\n",
      stderr: "",
    });
  });

  it("runs in the repository root", async () => {
    // Git Bash prints a drive path as /c/..., so the test compares a file the command creates.
    await verify("pwd > where.txt");

    expect((await stat(join(repo, "where.txt"))).isFile()).toBe(true);
  });

  it("runs non-interactively: stdin is closed and CI=1, TERM=dumb are set", async () => {
    const result = await verify('read line; echo "got:$line"; echo "$CI $TERM"', {
      timeoutMs: 5_000,
    });

    expect(withoutDuration(result)).toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "got:\n1 dumb\n",
      stderr: "",
    });
  });

  it("measures how long the command ran", async () => {
    const result = await verify("sleep 0.2");

    expect(result.durationMs).toBeGreaterThanOrEqual(200);
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it("bounds long output to the shared 40 KiB budget, keeping both ends", async () => {
    const result = await verify(
      'i=0; while [ $i -lt 3000 ]; do echo "line $i of a long test log"; i=$((i+1)); done; exit 1',
    );
    if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(result.stdout).toStartWith("line 0 of a long test log\n");
    expect(result.stdout).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(result.stdout).toEndWith("line 2999 of a long test log\n");
    expect(result.exitCode).toBe(1);
  });

  it.skipIf(noPosixSignals)(
    "reports a shell killed by a signal it did not get from the runner as 128 plus the signal",
    async () => {
      expect(withoutDuration(await verify("echo before; kill -KILL $$"))).toEqual({
        status: "completed",
        exitCode: 137,
        stdout: "before\n",
        stderr: "",
      });
    },
  );
});

describe("bounding the verification command", () => {
  it("stops a command at its timeout and keeps what it printed as timed_out", async () => {
    const result = await verify("echo started; sleep 10", { timeoutMs: 300 });

    expect(withoutDuration(result)).toEqual({
      status: "timed_out",
      timeoutMs: 300,
      stdout: "started\n",
      stderr: "",
    });
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it("gives a command 30,000 ms when no timeout is configured", async () => {
    expect((await verify("sleep 1", { timeoutMs: 300 })).status).toBe("timed_out");
    expect((await verify("sleep 1")).status).toBe("completed");
  });

  it("refuses a timeout outside bash's bounds when the runner is created", () => {
    for (const timeoutMs of [0, 1.5, 120_001, Number.NaN]) {
      expect(createVerificationRunner({ launcher, workspace, timeoutMs })).toEqual({
        ok: false,
        code: "INVALID_CONFIGURATION",
        message: `timeoutMs must be a whole number of milliseconds from 1 to 120000, got ${JSON.stringify(String(timeoutMs))}`,
        field: "timeoutMs",
      });
    }
    expect(createVerificationRunner({ launcher, workspace, timeoutMs: 120_000 }).ok).toBe(true);
  });

  it("ends the command when the signal aborts and reports it as cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await verify("echo started; sleep 30", { signal: controller.signal });

    expect(withoutDuration(result)).toEqual({
      status: "cancelled",
      stdout: "started\n",
      stderr: "",
    });
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it.skipIf(noPosixSignals)("stops what the command started when it is cancelled", async () => {
    const controller = new AbortController();
    const pidFile = join(sandbox, "background.pid");
    setTimeout(() => controller.abort(), 300);
    await verify(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; sleep 30`, {
      signal: controller.signal,
    });

    expect(await exitsSoon(Number((await readFile(pidFile, "utf8")).trim()))).toBe(true);
  });

  it("starts nothing when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await verify("touch ran", { signal: controller.signal });

    expect(withoutDuration(result)).toEqual({ status: "cancelled", stdout: "", stderr: "" });
    expect(await stat(join(repo, "ran")).catch(() => "missing")).toBe("missing");
  });
});

describe("the verification command's environment", () => {
  const keys = ["CDA74_PROVIDER_KEY", "CDA74_TASK_VAR"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CDA74_PROVIDER_KEY = "fake-provider-key";
    process.env.CDA74_TASK_VAR = "visible-to-the-task";
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("cannot read a credential the launcher filters, while other variables stay visible", async () => {
    const result = await verify(
      'echo "key=$(printenv CDA74_PROVIDER_KEY || echo unset) task=$CDA74_TASK_VAR"',
    );

    expect(withoutDuration(result)).toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "key=unset task=visible-to-the-task\n",
      stderr: "",
    });
  });
});

describe("a host with no shell", () => {
  it("reports launch_failed without starting anything", async () => {
    const created = createVerificationRunnerOn(
      { platform: "linux", env: { PATH: "" }, isExecutable: () => false },
      { launcher, workspace },
    );
    if (!created.ok) throw new Error(created.message);
    const result = await created.runner.run("touch ran", {
      signal: new AbortController().signal,
    });

    expect(withoutDuration(result)).toEqual({
      status: "launch_failed",
      error: "no shell found: neither bash on PATH nor /bin/sh exists",
    });
    expect(await stat(join(repo, "ran")).catch(() => "missing")).toBe("missing");
  });
});

async function exitsSoon(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 2_000; waited += 50) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
