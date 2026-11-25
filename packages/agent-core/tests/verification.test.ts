import { describe, expect, it } from "bun:test";
import type { AgentState, VerificationDecision } from "../src/index.ts";
import {
  collect,
  fakeWriteTool,
  openTestRun,
  textMessage,
  textTurn,
  toolCallTurn,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const objective = { role: "user", content: "Fix the failing test" } as const;

const testsPass: VerificationDecision = {
  outcome: "succeeded",
  evidence: [
    {
      type: "command_execution",
      command: "bun test",
      exitCode: 0,
      stdout: "1 pass",
      stderr: "",
      durationMs: 40,
    },
  ],
};

const feedback = {
  role: "user",
  content: "[Verification Failed]\nCommand: bun test\nExit code: 1\nOutput:\n1 fail",
} as const;

const testsFail: VerificationDecision = {
  outcome: "continue",
  evidence: [
    {
      type: "command_execution",
      command: "bun test",
      exitCode: 1,
      stdout: "1 fail",
      stderr: "",
      durationMs: 40,
    },
  ],
  feedback,
};

const testsCannotRun: Extract<VerificationDecision, { outcome: "failed" }> = {
  outcome: "failed",
  evidence: [
    {
      type: "command_system_failure",
      command: "bun test",
      failureKind: "launch_failed",
      message: "bun: command not found",
      exitCode: 127,
      durationMs: 3,
    },
  ],
  message: "bun: command not found",
};

describe("verifying a Candidate Completion", () => {
  it("waits in verifying while the policy judges the candidate", async () => {
    let during: AgentState | undefined;
    const { run, verification } = openTestRun({
      model: { turns: [textTurn("Fixed it.")] },
      verification: [
        async () => {
          during = run.snapshot();
          return testsPass;
        },
      ],
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(during).toMatchObject({
      phase: "verifying",
      verification: {
        verificationId: "verification-1",
        candidate: { modelTurnId: "model_turn-1", messageId: "assistant_message-1" },
      },
    });
    expect(verification.candidates).toEqual([
      {
        transcript: [objective, textMessage("Fixed it.")],
        finalMessage: textMessage("Fixed it."),
        workspaceChanged: false,
      },
    ]);
  });

  it("settles succeeded with the candidate and the policy's evidence when the policy succeeds", async () => {
    const { run } = openTestRun({
      model: { turns: [textTurn("Fixed it.")] },
      verification: [testsPass],
    });

    await run.dispatch({ type: "start", task });

    expect(await run.result()).toMatchObject({
      outcome: "succeeded",
      finalMessage: textMessage("Fixed it."),
      verification: testsPass,
    });
    expect(run.snapshot().phase).toBe("succeeded");
  });

  it("appends the feedback and asks the model again in a new Model Turn when the policy continues", async () => {
    const { run, model } = openTestRun({
      model: { turns: [textTurn("Fixed it."), textTurn("Fixed it properly.")] },
      verification: [testsFail, testsPass],
    });

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());

    expect(model.requests[1]?.context.messages).toEqual([
      objective,
      textMessage("Fixed it."),
      feedback,
    ]);
    expect(
      events
        .filter(
          (event) => event.type === "verification_completed" || event.type === "model_turn_started",
        )
        .map(({ type, data }) => ({ type, data })),
    ).toMatchObject([
      { type: "model_turn_started", data: { modelTurnId: "model_turn-1", index: 0 } },
      { type: "verification_completed", data: { verificationId: "verification-1", ...testsFail } },
      { type: "model_turn_started", data: { modelTurnId: "model_turn-2", index: 1 } },
      { type: "verification_completed", data: { verificationId: "verification-2", ...testsPass } },
    ]);
  });

  it("settles succeeded with the next candidate once the policy accepts it", async () => {
    const { run } = openTestRun({
      model: { turns: [textTurn("Fixed it."), textTurn("Fixed it properly.")] },
      verification: [testsFail, testsPass],
    });

    await run.dispatch({ type: "start", task });

    expect(await run.result()).toMatchObject({
      outcome: "succeeded",
      finalMessage: textMessage("Fixed it properly."),
      verification: testsPass,
    });
    expect(run.snapshot().transcript).toEqual([
      objective,
      textMessage("Fixed it."),
      feedback,
      textMessage("Fixed it properly."),
    ]);
  });

  it("settles failed with VERIFICATION_FAILED when the policy fails", async () => {
    const { run } = openTestRun({
      model: { turns: [textTurn("Fixed it.")] },
      verification: [testsCannotRun],
    });

    await run.dispatch({ type: "start", task });

    expect(await run.result()).toEqual({
      outcome: "failed",
      failure: { code: "VERIFICATION_FAILED", message: "bun: command not found" },
      finalMessage: textMessage("Fixed it."),
      verification: { outcome: "failed", evidence: testsCannotRun.evidence },
      usage: { inputTokens: 10, outputTokens: 5 },
      workspaceChanged: false,
      partialChangesPossible: false,
      lastSequence: 10,
    });
    expect(run.snapshot().phase).toBe("failed");
  });

  it("closes the Verification run and settles INTERNAL_ERROR when the policy throws", async () => {
    const { run } = openTestRun({
      model: { turns: [textTurn("Fixed it.")] },
      verification: [() => Promise.reject(new Error("runner crashed"))],
    });

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());

    expect(events.slice(-2)).toMatchObject([
      {
        type: "verification_completed",
        data: { verificationId: "verification-1", outcome: "failed", evidence: [] },
      },
      { type: "run_settled", data: { result } },
    ]);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "INTERNAL_ERROR", message: expect.stringContaining("runner crashed") },
    });
  });

  it("settles INTERNAL_ERROR when the policy reports a cancellation nobody requested", async () => {
    const { run } = openTestRun({
      model: { turns: [textTurn("Fixed it.")] },
      verification: [{ outcome: "cancelled" }],
    });

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());

    expect(events.slice(-2)).toMatchObject([
      {
        type: "verification_completed",
        data: { verificationId: "verification-1", outcome: "failed", evidence: [] },
      },
      { type: "run_settled", data: { result } },
    ]);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "INTERNAL_ERROR",
        message: "the Verification Policy reported a cancellation that was not requested",
      },
    });
  });

  it("marks partialChangesPossible when verification fails after workspace was changed by a mutating tool", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      approvalPolicy: "auto-approve",
      model: {
        turns: [
          toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "src/a.ts" } }),
          textTurn("Fixed it."),
        ],
      },
      verification: [
        {
          outcome: "failed",
          evidence: [
            {
              type: "command_execution",
              command: "bun test",
              exitCode: 1,
              stdout: "1 fail",
              stderr: "",
              durationMs: 40,
            },
          ],
          message: "Tests failed",
        },
      ],
    });

    await run.dispatch({ type: "start", task });
    const result = await run.result();

    expect(result.outcome).toBe("failed");
    expect(result.workspaceChanged).toBe(true);
    expect(result.partialChangesPossible).toBe(true);
    expect(
      (run.snapshot() as Extract<AgentState, { phase: "failed" }>).partialChangesPossible,
    ).toBe(true);
  });
});
