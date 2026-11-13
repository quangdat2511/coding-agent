import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecuteContext,
  PrepareOutcome,
  ToolOutcome,
  ToolProgress,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { Value } from "typebox/value";
import { DEFAULT_BASH_TIMEOUT_MS } from "../src/bash.ts";
import {
  BashParams,
  bashTool,
  createChildProcessLauncher,
  createWorkspaceResolver,
} from "../src/index.ts";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";
import { noPosixSignals } from "./platform.ts";

let sandbox: string;
let repo: string;
let workspace: WorkspaceResolver;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "bash-tool-")));
  repo = join(sandbox, "repo");
  await mkdir(repo);
  const created = await createWorkspaceResolver(repo);
  if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
  workspace = created.workspace;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

const launcherFor = (credentialEnvVars: readonly string[] = ["CDA71_PROVIDER_KEY"]) => {
  const configured = createChildProcessLauncher(credentialEnvVars);
  if (!configured.ok) throw new Error(configured.message);
  return configured.launcher;
};

type BashInput = { command: string; timeoutMs?: number; cwd?: string };

interface Run {
  readonly prepared: PrepareOutcome<typeof BashParams>;
  readonly outcome?: ToolOutcome;
  readonly progress: readonly string[];
}

interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: ToolProgress) => void;
}

async function run(input: BashInput, options: RunOptions = {}): Promise<Run> {
  const tool = bashTool(launcherFor());
  const progress: string[] = [];
  const ctx: ExecuteContext = {
    workspace,
    signal: options.signal ?? new AbortController().signal,
    onProgress: (update: ToolProgress) => {
      progress.push(update.output);
      options.onProgress?.(update);
    },
  };
  const prepared = await tool.prepare(input, ctx);
  if (!prepared.ok) return { prepared, progress };
  return { prepared, outcome: await tool.execute(prepared.prepared, ctx), progress };
}

async function outcomeOf(input: BashInput, options: RunOptions = {}) {
  const { prepared, outcome } = await run(input, options);
  if (!prepared.ok) throw new Error(`expected prepare to pass, got ${prepared.code}`);
  return outcome as ToolOutcome;
}

describe("running a command through bash", () => {
  it("returns the command's output followed by its exit code", async () => {
    expect(await outcomeOf({ command: "echo hello" })).toEqual({
      isError: false,
      content: "hello\n[exit code: 0]",
    });
  });

  it("returns a failing command's output with its exit code as NON_ZERO_EXIT", async () => {
    expect(await outcomeOf({ command: "echo oops >&2; exit 3" })).toEqual({
      isError: true,
      content: "oops\n[exit code: 3; partial changes may remain]",
      error: {
        code: "NON_ZERO_EXIT",
        message: "oops\n[exit code: 3; partial changes may remain]",
      },
    });
  });

  it("keeps stdout and stderr in the order the command wrote them", async () => {
    const outcome = await outcomeOf({
      command: "for i in 1 2 3; do echo out $i; echo err $i >&2; done",
    });

    expect(outcome.content).toBe("out 1\nerr 1\nout 2\nerr 2\nout 3\nerr 3\n[exit code: 0]");
  });

  it("says so when a command prints nothing or ends without a newline", async () => {
    expect((await outcomeOf({ command: "true" })).content).toBe("(no output)\n[exit code: 0]");
    expect((await outcomeOf({ command: "printf done" })).content).toBe("done\n[exit code: 0]");
  });

  it("runs non-interactively, so a command that reads stdin ends instead of waiting", async () => {
    const outcome = await outcomeOf({
      command: 'read line; echo "read=$? CI=$CI TERM=$TERM"; cat; echo cat-ended',
      timeoutMs: 5_000,
    });

    expect(outcome.content).toBe("read=1 CI=1 TERM=dumb\ncat-ended\n[exit code: 0]");
  });

  it("keeps a heredoc in the command intact", async () => {
    const outcome = await outcomeOf({ command: "cat <<EOF\nfirst\nsecond\nEOF" });

    expect(outcome.content).toBe("first\nsecond\n[exit code: 0]");
  });
});

describe("bounding a command", () => {
  it("refuses a timeout above 120,000 ms in the contract rather than honouring it", async () => {
    expect(Value.Check(BashParams, { command: "true", timeoutMs: 120_000 })).toBe(true);
    expect(Value.Check(BashParams, { command: "true", timeoutMs: 120_001 })).toBe(false);
    expect(Value.Check(BashParams, { command: "true", timeoutMs: 1.5 })).toBe(false);
    expect(Value.Check(BashParams, { command: "" })).toBe(false);

    const { prepared } = await run({ command: "true", timeoutMs: 120_001 });
    expect(prepared).toEqual({
      ok: false,
      code: "SCHEMA_VIOLATION",
      message: "timeoutMs must be a whole number of milliseconds from 1 to 120000",
    });
  });

  it("refuses in prepare exactly the inputs the schema refuses", async () => {
    // bash repeats the schema's rules for a caller that skips Schema Validation; the two must not
    // drift apart when BashParams changes.
    const inputs: readonly Record<string, unknown>[] = [
      { command: "true" },
      {},
      { command: "" },
      { command: 1 },
      { command: "true", timeoutMs: 1 },
      { command: "true", timeoutMs: 0 },
      { command: "true", timeoutMs: 120_000 },
      { command: "true", timeoutMs: 120_001 },
      { command: "true", timeoutMs: 1.5 },
      { command: "true", timeoutMs: Number.NaN },
      { command: "true", timeoutMs: "300" },
      { command: "true", cwd: "." },
      { command: "true", cwd: "" },
      { command: "true", cwd: 1 },
      { command: "true", unknown: 1 },
    ];
    const tool = bashTool(launcherFor());
    const ctx = { workspace, signal: new AbortController().signal };

    for (const input of inputs) {
      const prepared = await tool.prepare(input as BashInput, ctx);
      const refused = !prepared.ok && prepared.code === "SCHEMA_VIOLATION";
      expect({ input, refused }).toEqual({ input, refused: !Value.Check(BashParams, input) });
    }
  });

  it("gives a command 30,000 ms when it asks for no timeout", async () => {
    expect(DEFAULT_BASH_TIMEOUT_MS).toBe(30_000);
    // The same command that outlives a 300 ms timeout finishes under the default.
    expect(codeOf(await outcomeOf({ command: "sleep 1", timeoutMs: 300 }))).toBe("TIMEOUT");
    expect(await outcomeOf({ command: "sleep 1" })).toEqual({
      isError: false,
      content: "(no output)\n[exit code: 0]",
    });
  });

  it("stops a command at its timeout and keeps what it printed as TIMEOUT", async () => {
    const started = performance.now();
    const outcome = await outcomeOf({ command: "echo started; sleep 10", timeoutMs: 300 });

    expect(outcome).toEqual({
      isError: true,
      content: "started\n[timed out after 300 ms; partial changes may remain]",
      error: {
        code: "TIMEOUT",
        message: "started\n[timed out after 300 ms; partial changes may remain]",
      },
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(noPosixSignals)("stops what the command started when it times out", async () => {
    const pidFile = join(sandbox, "background.pid");
    await outcomeOf({ command: `sleep 30 & echo $! > ${pidFile}; sleep 30`, timeoutMs: 300 });
    const pid = Number((await readFile(pidFile, "utf8")).trim());

    expect(await exitsSoon(pid)).toBe(true);
  });

  it.skipIf(noPosixSignals)(
    "kills a command that ignores SIGTERM after a grace period",
    async () => {
      const started = performance.now();
      const outcome = await outcomeOf({ command: 'trap "" TERM; sleep 30', timeoutMs: 300 });

      expect(codeOf(outcome)).toBe("TIMEOUT");
      expect(performance.now() - started).toBeLessThan(3_000);
    },
  );

  it.skipIf(noPosixSignals)(
    "reports a shell killed by a signal it did not get from bash as SIGNAL",
    async () => {
      expect(await outcomeOf({ command: "echo before; kill -KILL $$" })).toEqual({
        isError: true,
        content: "before\n[terminated by SIGKILL; partial changes may remain]",
        error: {
          code: "SIGNAL",
          message: "before\n[terminated by SIGKILL; partial changes may remain]",
        },
      });
    },
  );

  it("does not wait for a background process that keeps the output open", async () => {
    const started = performance.now();
    const outcome = await outcomeOf({ command: "sleep 5 & echo done" });

    expect(outcome.content).toBe("done\n[exit code: 0]");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("bounds long output to the shared budget, status line included", async () => {
    const outcome = await outcomeOf({
      command:
        'i=0; while [ $i -lt 3000 ]; do echo "line $i of a long build log"; i=$((i+1)); done; exit 1',
    });

    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(outcome.content).toStartWith("line 0 of a long build log\n");
    expect(outcome.content).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(outcome.content).toEndWith(
      "line 2999 of a long build log\n[exit code: 1; partial changes may remain]",
    );
  });

  it("ends the command when the Tool Call is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = performance.now();
    const outcome = await outcomeOf({ command: "sleep 30" }, { signal: controller.signal });

    expect(codeOf(outcome)).toBe("SIGNAL");
    expect(outcome.content).toBe("(no output)\n[cancelled; partial changes may remain]");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(noPosixSignals)("stops what the command started when it is cancelled", async () => {
    const controller = new AbortController();
    const pidFile = join(sandbox, "cancelled.pid");
    setTimeout(() => controller.abort(), 300);
    await outcomeOf(
      { command: `sleep 30 & echo $! > ${pidFile}; sleep 30` },
      { signal: controller.signal },
    );

    expect(await exitsSoon(Number((await readFile(pidFile, "utf8")).trim()))).toBe(true);
  });

  it.skipIf(noPosixSignals)(
    "reports a command that already exited normally when cancellation arrives while reading its output",
    async () => {
      const controller = new AbortController();
      const pidFile = join(sandbox, "background.pid");
      // The shell exits at once, but the background sleep keeps the pipe open, so bash is still
      // reading when the abort arrives.
      setTimeout(() => controller.abort(), 100);
      const outcome = await outcomeOf(
        { command: `sleep 5 & echo $! > ${pidFile}; echo done` },
        { signal: controller.signal },
      );
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      await Bun.sleep(1_200);

      expect(outcome).toEqual({ isError: false, content: "done\n[exit code: 0]" });
      expect(isAlive(pid)).toBe(true);
      process.kill(pid, "SIGKILL");
    },
  );

  it("keeps collecting output when a progress observer throws", async () => {
    const outcome = await outcomeOf(
      { command: "echo one; sleep 0.1; echo two" },
      {
        onProgress: () => {
          throw new Error("observer failed");
        },
      },
    );

    expect(outcome).toEqual({ isError: false, content: "one\ntwo\n[exit code: 0]" });
  });
});

describe("the command's environment", () => {
  const keys = ["CDA71_PROVIDER_KEY", "CDA71_TASK_VAR"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CDA71_PROVIDER_KEY = "fake-provider-key";
    process.env.CDA71_TASK_VAR = "visible-to-the-task";
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("cannot read a credential the launcher filters, while other variables stay visible", async () => {
    const outcome = await outcomeOf({
      command: 'echo "key=$(printenv CDA71_PROVIDER_KEY || echo unset) task=$CDA71_TASK_VAR"',
    });

    expect(outcome.content).toBe("key=unset task=visible-to-the-task\n[exit code: 0]");
  });
});

describe("the start directory", () => {
  it("starts in the repository root by default, or in the directory given", async () => {
    // Listing names compares the same way on every platform; Git Bash prints a drive path as /c/.
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "main.ts"), "");

    expect((await outcomeOf({ command: "ls" })).content).toBe("src\n[exit code: 0]");
    expect((await outcomeOf({ command: "ls", cwd: "src" })).content).toBe(
      "main.ts\n[exit code: 0]",
    );
  });

  it("refuses every unusable start directory as PATH_OUTSIDE_REPO", async () => {
    await writeFile(join(repo, "notes.txt"), "text");

    for (const cwd of ["..", sandbox, "missing"]) {
      const { prepared } = await run({ command: "true", cwd });
      expect(prepared.ok ? "ok" : prepared.code).toBe("PATH_OUTSIDE_REPO");
    }
    const { prepared } = await run({ command: "true", cwd: "notes.txt" });
    expect(prepared).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: 'cwd "notes.txt" is not a directory',
    });
  });

  it("refuses a start directory removed after prepare", async () => {
    await mkdir(join(repo, "build"));
    const tool = bashTool(launcherFor());
    const ctx = { workspace, signal: new AbortController().signal, onProgress: () => {} };
    const prepared = await tool.prepare({ command: "true", cwd: "build" }, ctx);
    if (!prepared.ok) throw new Error(prepared.message);
    await rm(join(repo, "build"), { recursive: true });

    const outcome = await tool.execute(prepared.prepared, ctx);
    expect(codeOf(outcome)).toBe("PATH_OUTSIDE_REPO");
  });
});

describe("approving a command", () => {
  it("shows the whole command, its start directory, and a non-default timeout", async () => {
    await mkdir(join(repo, "src"));
    const multiLine = "cat <<EOF > notes.txt\nfirst\nEOF";

    const plain = await run({ command: "bun test" });
    const detailed = await run({ command: multiLine, cwd: "src", timeoutMs: 60_000 });

    expect(plain.prepared.ok && plain.prepared.prepared.summary).toBe('run "bun test"');
    expect(detailed.prepared.ok && detailed.prepared.prepared.summary).toBe(
      'run "cat <<EOF > notes.txt\\nfirst\\nEOF" in "src"; timeout 60000 ms',
    );
  });

  it("is classified mutating", () => {
    expect(bashTool(launcherFor()).mutation).toBe("mutating");
  });
});

describe("reporting progress", () => {
  it("reports the latest output while the command runs", async () => {
    const { progress } = await run({ command: "echo one; sleep 0.2; echo two" });

    expect(progress.at(0)).toBe("one\n");
    expect(progress.at(-1)).toBe("one\ntwo\n");
  });
});

const codeOf = (outcome: ToolOutcome) => (outcome.isError ? outcome.error.code : undefined);

// A killed process can linger as a zombie until its new parent reaps it, and signal 0 still
// reaches a zombie, so wait briefly for it to disappear.
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
