import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  VerificationCancelled,
  VerificationCandidate,
  VerificationDecision,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import {
  createChildProcessLauncher,
  createVerificationPolicy,
  createVerificationRunner,
  createWorkspaceResolver,
  type VerificationRunner,
  type VerificationRunnerResult,
} from "../src/index.ts";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";

// Buffer.from counts the bytes Bun's Buffer.byteLength can miscount (src/output-budget.ts).
const bytes = (text: string) => Buffer.from(text, "utf8").byteLength;

interface FakeRunner extends VerificationRunner {
  readonly commands: readonly string[];
}

// The runner is the port the policy is given, so a scripted one shows every result the policy maps.
function runnerReturning(result: VerificationRunnerResult): FakeRunner {
  const commands: string[] = [];
  return {
    commands,
    async run(command) {
      commands.push(command);
      return result;
    },
  };
}

function candidate(workspaceChanged = true): VerificationCandidate {
  return {
    transcript: [],
    finalMessage: {
      role: "assistant",
      content: [{ type: "text", text: "Fixed it." }],
      model: "test-model",
      finishReason: { reason: "end_turn", rawReason: "stop" },
    },
    workspaceChanged,
  };
}

const ctx = { signal: new AbortController().signal, onProgress: () => {} };

// Runs the policy over one scripted result and narrows away cancellation, which no caller expects.
async function decisionFor(
  command: string,
  result: VerificationRunnerResult,
): Promise<VerificationDecision> {
  const decided = await createVerificationPolicy({
    command,
    runner: runnerReturning(result),
  }).verify(candidate(), ctx);
  if (decided.outcome === "cancelled") throw new Error("expected a decision, got cancelled");
  return decided;
}

// Narrows to continue. The policy writes its feedback as text, so the content is a string.
function continued(decision: VerificationDecision | VerificationCancelled) {
  if (decision.outcome !== "continue")
    throw new Error(`expected continue, got ${decision.outcome}`);
  const { content } = decision.feedback;
  if (typeof content !== "string") throw new Error("expected text feedback");
  return { evidence: decision.evidence, content };
}

describe("deciding a configured command's result", () => {
  it("succeeds with the run as command_execution evidence when the command exits 0", async () => {
    const runner = runnerReturning({
      status: "completed",
      exitCode: 0,
      stdout: "1 pass\n",
      stderr: "",
      durationMs: 850,
    });
    const policy = createVerificationPolicy({ command: "bun test", runner });

    expect(await policy.verify(candidate(), ctx)).toEqual({
      outcome: "succeeded",
      evidence: [
        {
          type: "command_execution",
          command: "bun test",
          exitCode: 0,
          stdout: "1 pass\n",
          stderr: "",
          durationMs: 850,
        },
      ],
    });
    expect(runner.commands).toEqual(["bun test"]);
  });

  it("continues with [Verification Failed] feedback naming the command, exit code and output when the command exits non-zero", async () => {
    const runner = runnerReturning({
      status: "completed",
      exitCode: 1,
      stdout: "1 fail\nexpected 2, got 3\n",
      stderr: "",
      durationMs: 850,
    });
    const policy = createVerificationPolicy({ command: "bun test", runner });

    expect(await policy.verify(candidate(), ctx)).toEqual({
      outcome: "continue",
      evidence: [
        {
          type: "command_execution",
          command: "bun test",
          exitCode: 1,
          stdout: "1 fail\nexpected 2, got 3\n",
          stderr: "",
          durationMs: 850,
        },
      ],
      feedback: {
        role: "user",
        content:
          "[Verification Failed]\n" +
          "Command: bun test\n" +
          "Exit code: 1\n" +
          "Output:\n" +
          "1 fail\n" +
          "expected 2, got 3\n" +
          "Please analyze the failure, adjust your changes, and verify again.",
      },
    });
  });
});

describe("reporting a cancelled run", () => {
  it("reports cancelled rather than a decision when the abort signal ended the run", async () => {
    const abort = new AbortController();
    const signals: AbortSignal[] = [];
    const runner: VerificationRunner = {
      async run(_command, { signal }) {
        signals.push(signal);
        abort.abort();
        return { status: "cancelled", stdout: "running 12 tests\n", stderr: "", durationMs: 7 };
      },
    };
    const policy = createVerificationPolicy({ command: "bun test", runner });

    expect(
      await policy.verify(candidate(), { signal: abort.signal, onProgress: () => {} }),
    ).toEqual({ outcome: "cancelled" });
    expect(signals).toEqual([abort.signal]);
  });
});

describe("writing the [Verification Failed] feedback", () => {
  async function feedbackFor(stdout: string): Promise<string> {
    const decision = await decisionFor("make check", {
      status: "completed",
      exitCode: 2,
      stdout,
      stderr: "",
      durationMs: 5,
    });
    return continued(decision).content;
  }

  it("starts the closing line on its own line when the output does not end with a newline", async () => {
    expect(await feedbackFor("make: *** [check] Error 1")).toBe(
      "[Verification Failed]\nCommand: make check\nExit code: 2\nOutput:\n" +
        "make: *** [check] Error 1\n" +
        "Please analyze the failure, adjust your changes, and verify again.",
    );
  });

  it("says (no output) when the command printed nothing, as bash does", async () => {
    expect(await feedbackFor("")).toBe(
      "[Verification Failed]\nCommand: make check\nExit code: 2\nOutput:\n" +
        "(no output)\n" +
        "Please analyze the failure, adjust your changes, and verify again.",
    );
  });
});

describe("keeping output within the 40 KiB budget", () => {
  // 30,000 one-byte characters then 10,000 two-byte ones: 50,000 bytes, so a cut can fall inside
  // a character.
  const oversized = `${"a".repeat(30_000)}${"é".repeat(10_000)}`;

  function expectWithinBudget(output: string) {
    expect(bytes(output)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(output).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(output.startsWith("aaaa")).toBe(true);
    expect(output.endsWith("éééé")).toBe(true);
    expect(output).not.toContain("�");
  }

  async function decideCompleted(stdout: string) {
    const { evidence: recorded, content } = continued(
      await decisionFor("bun test", {
        status: "completed",
        exitCode: 1,
        stdout,
        stderr: "",
        durationMs: 5,
      }),
    );
    const [evidence] = recorded;
    if (evidence?.type !== "command_execution") throw new Error("expected command_execution");
    const output = content.slice(
      content.indexOf("Output:\n") + "Output:\n".length,
      content.lastIndexOf("Please analyze"),
    );
    return { evidence, output };
  }

  it("bounds the output in both the feedback and the evidence", async () => {
    const { evidence, output } = await decideCompleted(oversized);

    expectWithinBudget(output.replace(/\n$/, ""));
    expectWithinBudget(evidence.stdout);
  });

  it("keeps output of exactly 40,960 bytes whole", async () => {
    const exact = `${"a".repeat(MAX_TOOL_OUTPUT_BYTES - 2)}é`;

    const { evidence, output } = await decideCompleted(exact);

    expect(evidence.stdout).toBe(exact);
    expect(output).toBe(`${exact}\n`);
  });

  it("cuts output one byte over the budget", async () => {
    const { evidence } = await decideCompleted(`${"a".repeat(MAX_TOOL_OUTPUT_BYTES - 1)}é`);

    expect(bytes(evidence.stdout)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(evidence.stdout).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
  });

  it("bounds what a timed-out command printed", async () => {
    const decision = await decisionFor("bun test", {
      status: "timed_out",
      timeoutMs: 30_000,
      stdout: oversized,
      stderr: "",
      durationMs: 30_001,
    });

    const [evidence] = decision.evidence;
    if (evidence?.type !== "command_system_failure") throw new Error("expected a system failure");
    expectWithinBudget(evidence.stdout ?? "");
  });

  // ADR 0003 §3 applies the budget to combined stdout and stderr. The runner leaves stderr empty,
  // so only a runner that fills both streams reaches this.
  for (const status of ["completed", "timed_out"] as const) {
    it(`keeps a ${status} run's two streams within one budget together`, async () => {
      const streams = { stdout: "a".repeat(30_000), stderr: "b".repeat(30_000) };
      const decision = await decisionFor(
        "bun test",
        status === "completed"
          ? { status, exitCode: 1, ...streams, durationMs: 5 }
          : { status, timeoutMs: 30_000, ...streams, durationMs: 30_001 },
      );

      const [evidence] = decision.evidence;
      if (evidence === undefined || evidence.type === "no_command_configured") {
        throw new Error("expected a command run");
      }
      const { stdout = "", stderr = "" } = evidence;
      expect(bytes(stdout) + bytes(stderr)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
      expect(stdout).toStartWith("aaaa");
      expect(stdout).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
      expect(stderr).toEndWith("bbbb");
      expect(stderr).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    });
  }

  it("keeps a short stream whole and gives the rest of the budget to the long one", async () => {
    const stdout = "a".repeat(10_000);
    const decision = await decisionFor("bun test", {
      status: "completed",
      exitCode: 1,
      stdout,
      stderr: "b".repeat(50_000),
      durationMs: 5,
    });

    const [evidence] = decision.evidence;
    if (evidence?.type !== "command_execution") throw new Error("expected command_execution");
    expect(evidence.stdout).toBe(stdout);
    expect(bytes(evidence.stderr)).toBe(MAX_TOOL_OUTPUT_BYTES - 10_000);
  });

  it("bounds the error of a command that could not run", async () => {
    const decision = await decisionFor("bun test", {
      status: "launch_failed",
      error: oversized,
      durationMs: 2,
    });

    const [evidence] = decision.evidence;
    if (evidence?.type !== "command_system_failure") throw new Error("expected a system failure");
    expectWithinBudget(evidence.message);
  });
});

describe("verifying without a configured command", () => {
  // ADR 0003 §3: CodingTask cannot say whether a task was meant to change anything, so whether the
  // workspace changed is recorded and never decides the outcome.
  for (const workspaceChanged of [true, false]) {
    it(`succeeds without running anything and records workspaceChanged: ${workspaceChanged}`, async () => {
      const runner = runnerReturning({
        status: "completed",
        exitCode: 1,
        stdout: "",
        stderr: "",
        durationMs: 0,
      });
      const policy = createVerificationPolicy({ command: null, runner });

      expect(await policy.verify(candidate(workspaceChanged), ctx)).toEqual({
        outcome: "succeeded",
        evidence: [{ type: "no_command_configured", workspaceChanged }],
      });
      expect(runner.commands).toEqual([]);
    });
  }
});

describe("deciding a command that could not run to a result", () => {
  it("fails with timed_out command_system_failure evidence when the command times out", async () => {
    const runner = runnerReturning({
      status: "timed_out",
      timeoutMs: 30_000,
      stdout: "running 12 tests\n",
      stderr: "",
      durationMs: 30_004,
    });
    const policy = createVerificationPolicy({ command: "bun test", runner });

    expect(await policy.verify(candidate(), ctx)).toEqual({
      outcome: "failed",
      evidence: [
        {
          type: "command_system_failure",
          command: "bun test",
          failureKind: "timed_out",
          message: "timed out after 30000 ms",
          stdout: "running 12 tests\n",
          stderr: "",
          durationMs: 30_004,
        },
      ],
      message: 'the verification command "bun test" timed out after 30000 ms',
    });
  });

  it("fails with launch_failed evidence carrying the shell's exit code when the command is missing", async () => {
    const error = "exit code 127 (command not found or not executable):\nbash: bun: not found\n";
    const runner = runnerReturning({
      status: "launch_failed",
      error,
      exitCode: 127,
      durationMs: 3,
    });
    const policy = createVerificationPolicy({ command: "bun test", runner });

    expect(await policy.verify(candidate(), ctx)).toEqual({
      outcome: "failed",
      evidence: [
        {
          type: "command_system_failure",
          command: "bun test",
          failureKind: "launch_failed",
          message: error,
          exitCode: 127,
          durationMs: 3,
        },
      ],
      message: `the verification command "bun test" could not run: ${error}`,
    });
  });

  it("records no exit code when the shell could not start at all", async () => {
    const error = 'could not start "/bin/bash": ENOENT';
    const decision = await decisionFor("bun test", {
      status: "launch_failed",
      error,
      durationMs: 1,
    });

    expect(decision.outcome).toBe("failed");
    expect(decision.evidence).toEqual([
      {
        type: "command_system_failure",
        command: "bun test",
        failureKind: "launch_failed",
        message: error,
        durationMs: 1,
      },
    ]);
    expect(decision.evidence[0]).not.toHaveProperty("exitCode");
  });
});

describe("deciding what the real runner reports", () => {
  let sandbox: string;
  let workspace: WorkspaceResolver;

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(join(tmpdir(), "verification-policy-")));
    const created = await createWorkspaceResolver(sandbox);
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
    workspace = created.workspace;
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  function policyRunning(command: string) {
    const launcher = createChildProcessLauncher(["CDA77_PROVIDER_KEY"]);
    if (!launcher.ok) throw new Error(launcher.message);
    const runner = createVerificationRunner({ launcher: launcher.launcher, workspace });
    if (!runner.ok) throw new Error(runner.message);
    return createVerificationPolicy({ command, runner: runner.runner });
  }

  it("sends a failing command's long log back within the budget, keeping both ends", async () => {
    const command =
      'i=0; while [ $i -lt 3000 ]; do echo "line $i of a long test log"; i=$((i+1)); done; exit 3';

    const { evidence: recorded, content } = continued(
      await policyRunning(command).verify(candidate(), ctx),
    );

    expect(content).toStartWith(
      `[Verification Failed]\nCommand: ${command}\nExit code: 3\nOutput:\nline 0 of a long test log\n`,
    );
    expect(content).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(content).toEndWith(
      "line 2999 of a long test log\nPlease analyze the failure, adjust your changes, and verify again.",
    );
    const [evidence] = recorded;
    if (evidence?.type !== "command_execution") throw new Error("expected command_execution");
    expect(evidence.exitCode).toBe(3);
    expect(bytes(evidence.stdout)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  });

  it("fails the session's Verification when the command is not installed", async () => {
    const decision = await policyRunning("nonexistent_cda77_binary").verify(candidate(), ctx);

    expect(decision).toMatchObject({
      outcome: "failed",
      evidence: [{ type: "command_system_failure", failureKind: "launch_failed", exitCode: 127 }],
      message: expect.stringContaining('the verification command "nonexistent_cda77_binary"'),
    });
  });
});
