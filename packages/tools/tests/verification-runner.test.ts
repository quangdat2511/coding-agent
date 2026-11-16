import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceResolver } from "@coding-agent/agent-core";
import type { ChildProcessLauncher } from "../src/child-process.ts";
import {
  createChildProcessLauncher,
  createVerificationRunner,
  createWorkspaceResolver,
  type VerificationRunnerOptions,
  type VerificationRunnerResult,
} from "../src/index.ts";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";
import { createVerificationRunnerOn } from "../src/verification-runner.ts";
import { noModeBits, noPosixSignals } from "./platform.ts";

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

// A launcher that records every command it starts, so a test can tell that nothing started rather
// than relying on whether a file had time to appear.
function countingLauncher(inner: ChildProcessLauncher = launcher) {
  const started: (readonly string[])[] = [];
  const counting: ChildProcessLauncher = {
    launch: (argv, options) => {
      started.push(argv);
      return inner.launch(argv, options);
    },
  };
  return { launcher: counting, started };
}

describe("a signal that aborts before the command starts", () => {
  it("starts nothing when the signal aborts while the repository root is checked", async () => {
    const controller = new AbortController();
    const aborting: WorkspaceResolver = {
      ...workspace,
      resolveExisting: async (input) => {
        controller.abort();
        return workspace.resolveExisting(input);
      },
    };
    const { launcher: counting, started } = countingLauncher();
    const created = createVerificationRunner({ launcher: counting, workspace: aborting });
    if (!created.ok) throw new Error(created.message);
    const result = await created.runner.run("touch ran", { signal: controller.signal });

    expect(withoutDuration(result)).toEqual({ status: "cancelled", stdout: "", stderr: "" });
    expect(started).toEqual([]);
    expect(await missing(join(repo, "ran"))).toBe("missing");
  });

  // The stand-in's background sleep holds the pipes open, so the abort arrives while the check's
  // output is still read after its shell has exited. Its pid is an MSYS pid on Windows, which
  // process.kill cannot reach to clean up.
  it.skipIf(noPosixSignals)(
    "does not start the command when the signal aborts after the syntax check",
    async () => {
      const pidFile = join(sandbox, "check.pid");
      const { launcher: counting, started } = countingLauncher(
        slowSyntaxCheck(`sleep 5 & echo $! > ${JSON.stringify(pidFile)}; exit 0`),
      );
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const result = await runnerWith({ launcher: counting }).run("touch ran", {
        signal: controller.signal,
      });
      process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");

      expect(result.status).toBe("cancelled");
      expect(started).toHaveLength(1);
      expect(await missing(join(repo, "ran"))).toBe("missing");
    },
  );
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

const missing = (path: string) =>
  stat(path).then(
    () => "present",
    () => "missing",
  );

describe("a command that cannot run", () => {
  it("reports a missing binary as launch_failed with exit code 127", async () => {
    const result = await verify("nonexistent_cda74_binary");
    if (result.status !== "launch_failed") throw new Error(`got ${result.status}`);

    expect(result.exitCode).toBe(127);
    expect(result.error).toStartWith("exit code 127 (command not found or not executable):\n");
    expect(result.error).toContain("nonexistent_cda74_binary");
  });

  // Windows has no mode bits: Git Bash runs a file with a shebang whatever its permissions. Root
  // ignores read and write bits but not a missing execute bit, so this also holds as root.
  it.skipIf(noModeBits)(
    "reports a file that is not executable as launch_failed with 126",
    async () => {
      await writeFile(join(repo, "check.sh"), "#!/bin/sh\necho ran\n");
      await chmod(join(repo, "check.sh"), 0o644);
      const result = await verify("./check.sh");
      if (result.status !== "launch_failed") throw new Error(`got ${result.status}`);

      expect(result.exitCode).toBe(126);
      expect(result.error).not.toContain("ran\n");
    },
  );

  it("reports a command that exits 2 as completed, since a failing make exits 2 as well", async () => {
    expect(withoutDuration(await verify("echo failing; exit 2"))).toEqual({
      status: "completed",
      exitCode: 2,
      stdout: "failing\n",
      stderr: "",
    });
  });

  it("reports a shell syntax error as launch_failed without running any of the command", async () => {
    const result = await verify("touch ran\nif then");
    if (result.status !== "launch_failed") throw new Error(`got ${result.status}`);

    expect(result.exitCode).toBe(2);
    expect(result.error).toStartWith("shell syntax error:\n");
    expect(result.error).toContain("syntax error");
    expect(await missing(join(repo, "ran"))).toBe("missing");
  });

  it("refuses a repository root replaced by a symbolic link, running nothing outside it", async () => {
    const outside = join(sandbox, "outside");
    await mkdir(outside);
    await rename(repo, join(sandbox, "moved"));
    await symlink(outside, repo);
    const result = await verify("touch marker");

    expect(withoutDuration(result)).toEqual({
      status: "launch_failed",
      error: expect.stringContaining(
        `repository root ${JSON.stringify(workspace.repoRoot)} cannot be used: `,
      ),
    });
    expect(await missing(join(outside, "marker"))).toBe("missing");
  });

  it("refuses a repository root that was removed", async () => {
    await rm(repo, { recursive: true });
    const result = await verify("echo hi");

    expect(result.status).toBe("launch_failed");
    expect(result.status === "launch_failed" && result.error).toStartWith(
      `repository root ${JSON.stringify(workspace.repoRoot)} cannot be used: `,
    );
  });

  it("reports a shell that cannot be started as launch_failed instead of rejecting", async () => {
    const throwing: ChildProcessLauncher = {
      launch: () => {
        throw new Error("ENOENT: no such file or directory, posix_spawn '/bin/bash'");
      },
    };
    const result = await runnerWith({ launcher: throwing }).run("echo hi", {
      signal: new AbortController().signal,
    });

    expect(withoutDuration(result)).toEqual({
      status: "launch_failed",
      error: expect.stringMatching(
        /^could not start ".+": ENOENT: no such file or directory, posix_spawn '\/bin\/bash'$/,
      ),
    });
  });

  it("bounds the output in a launch failure to 40 KiB, reason included", async () => {
    const result = await verify(
      'i=0; while [ $i -lt 3000 ]; do echo "line $i of a long log"; i=$((i+1)); done; nonexistent_cda74_binary',
    );
    if (result.status !== "launch_failed") throw new Error(`got ${result.status}`);

    expect(Buffer.byteLength(result.error, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(result.error).toStartWith(
      "exit code 127 (command not found or not executable):\nline 0 ",
    );
    expect(result.error).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(result.error).toContain("nonexistent_cda74_binary");
  });
});

// A launcher whose syntax check (`<shell> -n -c ...`) runs `stand-in` instead, so a test can make
// the check slow without a command that is slow to parse.
function slowSyntaxCheck(standIn: string): ChildProcessLauncher {
  return {
    launch: (argv, options) =>
      argv[1] === "-n"
        ? launcher.launch([argv[0] ?? "", "-c", standIn], options)
        : launcher.launch(argv, options),
  };
}

describe("the syntax check", () => {
  it("shares the timeout with the command, so the whole run stays within it", async () => {
    const result = await runnerWith({ launcher: slowSyntaxCheck("sleep 0.4"), timeoutMs: 700 }).run(
      "sleep 5",
      { signal: new AbortController().signal },
    );

    expect(result.status).toBe("timed_out");
    expect(result.status === "timed_out" && result.timeoutMs).toBe(700);
    // Each with the full 700 ms, the two would take about 1,100 ms.
    expect(result.durationMs).toBeLessThan(1_000);
  });

  it.skipIf(noPosixSignals)(
    "reports a syntax check ended by a signal as such, not as a syntax error",
    async () => {
      const { launcher: counting, started } = countingLauncher(slowSyntaxCheck("kill -KILL $$"));
      const result = await runnerWith({ launcher: counting }).run("echo hi", {
        signal: new AbortController().signal,
      });

      expect(withoutDuration(result)).toEqual({
        status: "launch_failed",
        error: "the syntax check was ended by SIGKILL:\n",
      });
      expect(started).toHaveLength(1);
    },
  );

  it("is stopped by the timeout and by cancellation too", async () => {
    const timedOut = await runnerWith({ launcher: slowSyntaxCheck("sleep 5"), timeoutMs: 300 }).run(
      "touch ran",
      { signal: new AbortController().signal },
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const cancelled = await runnerWith({ launcher: slowSyntaxCheck("sleep 5") }).run("touch ran", {
      signal: controller.signal,
    });

    expect(timedOut.status).toBe("timed_out");
    expect(cancelled.status).toBe("cancelled");
    expect(timedOut.durationMs).toBeLessThan(3_000);
    expect(cancelled.durationMs).toBeLessThan(3_000);
    expect(await missing(join(repo, "ran"))).toBe("missing");
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
