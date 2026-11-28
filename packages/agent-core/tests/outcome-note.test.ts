import { describe, expect, it } from "bun:test";
import type { Message } from "@coding-agent/ai";
import type { AgentFailureCode, TranscriptWording } from "../src/index.ts";
import {
  abortIgnoringTool,
  collect,
  continueWith,
  fakeWording,
  fakeWriteTool,
  openTestRun,
  type TestKitOptions,
  textMessage,
  textTurn,
  throwingRequest,
  toolCallTurn,
  toolResultMessage,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const carried: Message[] = [
  { role: "user", content: "Add a sum function" },
  textMessage("Added sum."),
];

describe("Outcome Notes", () => {
  it("ends a cancelled run's Transcript with an Outcome Note before run_settled is published", async () => {
    const { run } = openTestRun({
      tools: [fakeWriteTool()],
      model: {
        turns: [toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "a.ts" } })],
      },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");
    await run.dispatch({ type: "cancel" });
    const settled = await waitForEvent(run, "run_settled");
    const atSettlement = run.snapshot().transcript;

    expect(settled.data).toEqual({
      result: await run.result(),
      outcomeNote: { role: "user", content: "task ended: cancelled" },
    });
    expect(atSettlement.at(-1)).toEqual({ role: "user", content: "task ended: cancelled" });
    expect((await collect(run.events())).at(-1)?.type).toBe("run_settled");
  });

  it.each([
    {
      code: "LIMIT_EXCEEDED",
      options: {
        model: { turns: [textTurn("Tried.")] },
        verification: [continueWith("Try again.")],
        limits: { maxModelTurns: 1 },
      },
    },
    {
      code: "VERIFICATION_FAILED",
      options: {
        model: { turns: [textTurn("Done.")] },
        verification: [{ outcome: "failed", evidence: [], message: "bun test timed out" }],
      },
    },
    {
      code: "MODEL_FAILURE",
      options: { model: { turns: [throwingRequest(new Error("connection reset"))] } },
    },
    {
      code: "MODEL_PROTOCOL_ERROR",
      options: { model: { turns: [[{ type: "stream_start" }]] } },
    },
    {
      code: "INTERNAL_ERROR",
      options: {
        model: { turns: [textTurn("Done.")] },
        verification: [() => Promise.reject(new Error("the policy broke"))],
      },
    },
  ] satisfies { code: AgentFailureCode; options: TestKitOptions }[])(
    "ends a run that failed with $code with an Outcome Note",
    async ({ code, options }) => {
      const { run } = openTestRun(options);

      await run.dispatch({ type: "start", task });
      const result = await run.result();
      const settled = (await collect(run.events())).at(-1);

      expect(result).toMatchObject({ outcome: "failed", failure: { code } });
      expect(settled).toMatchObject({
        type: "run_settled",
        data: { outcomeNote: { role: "user", content: `task ended: ${code}` } },
      });
      expect(run.snapshot().transcript.at(-1)).toEqual({
        role: "user",
        content: `task ended: ${code}`,
      });
    },
  );

  it("ends a run whose tool ignored the cancellation with an Outcome Note", async () => {
    const stubborn = abortIgnoringTool();
    const { run, clock } = openTestRun({
      tools: [stubborn],
      approvalPolicy: "auto-approve",
      limits: { cancellationGraceMs: 25 },
      model: { turns: [toolCallTurn({ toolCallId: "call-1", name: "stubborn", input: {} })] },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "tool_execution_started");
    await run.dispatch({ type: "cancel" });
    clock.advance(25);
    await run.result();
    stubborn.release();

    expect(run.snapshot().transcript.at(-1)).toEqual({
      role: "user",
      content: "task ended: CANCELLATION_TIMEOUT",
    });
  });

  it("adds none to a successful run and does not ask for one", async () => {
    const { run, portCalls } = openTestRun({ model: { turns: [textTurn("Done.")] } });

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const settled = (await collect(run.events())).at(-1);

    expect(settled?.data).toEqual({ result });
    expect(run.snapshot().transcript.at(-1)).toEqual(textMessage("Done."));
    expect(portCalls).not.toContain("wording.outcomeNote()");
  });

  it("adds none to a run cancelled before it started, which has no Coding Task to end", async () => {
    const { run, portCalls } = openTestRun({ transcript: carried });

    await run.dispatch({ type: "cancel" });
    const result = await run.result();
    const settled = (await collect(run.events())).at(-1);

    expect(result.outcome).toBe("cancelled");
    expect(settled?.data).toEqual({ result });
    expect(run.snapshot().transcript).toEqual(carried);
    expect(portCalls).not.toContain("wording.outcomeNote()");
  });

  it("adds none when the wording returns no note", async () => {
    const { run } = openTestRun({
      wording: { ...fakeWording(), outcomeNote: () => undefined },
      model: { turns: [throwingRequest(new Error("connection reset"))] },
    });

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const settled = (await collect(run.events())).at(-1);

    expect(settled?.data).toEqual({ result });
    expect(run.snapshot().transcript).toEqual([{ role: "user", content: task.objective }]);
  });
});

describe("a TranscriptWording that fails", () => {
  async function cancelAtApproval(wording: TranscriptWording) {
    const { run } = openTestRun({
      wording,
      tools: [fakeWriteTool()],
      model: {
        turns: [toolCallTurn({ toolCallId: "call-1", name: "write", input: { path: "a.ts" } })],
      },
    });
    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "approval_requested");
    await run.dispatch({ type: "cancel" });
    const result = await run.result();
    const events = await collect(run.events());
    return { transcript: run.snapshot().transcript, result, events };
  }

  const fails = (): never => {
    throw new Error("no words");
  };

  it("closes the call with an empty Tool Result and records why when closingToolResult throws", async () => {
    const { transcript, result, events } = await cancelAtApproval({
      ...fakeWording(),
      closingToolResult: fails,
    });

    expect(result.outcome).toBe("cancelled");
    expect(events.find((event) => event.type === "tool_call_completed")?.data).toEqual({
      toolCallId: "tool_call-1",
      outcome: "skipped",
      reason: "CANCELLED",
      result: { toolCallId: "tool_call-1", toolName: "write", content: "", isError: true },
    });
    expect(transcript).toContainEqual(toolResultMessage("call-1", ""));
    expect(events.at(-1)?.data).toEqual({
      result,
      outcomeNote: { role: "user", content: "task ended: cancelled" },
      wordingFailure: "TranscriptWording.closingToolResult threw: no words",
    });
  });

  it("adds no Outcome Note and records why when outcomeNote throws", async () => {
    const { transcript, result, events } = await cancelAtApproval({
      ...fakeWording(),
      outcomeNote: fails,
    });

    expect(result.outcome).toBe("cancelled");
    expect(transcript.at(-1)).toEqual(toolResultMessage("call-1", "write not run: CANCELLED"));
    expect(events.at(-1)?.data).toEqual({
      result,
      wordingFailure: "TranscriptWording.outcomeNote threw: no words",
    });
  });

  it("records the first failure when both throw", async () => {
    const { events } = await cancelAtApproval({ closingToolResult: fails, outcomeNote: fails });

    expect(events.at(-1)).toMatchObject({
      type: "run_settled",
      data: { wordingFailure: "TranscriptWording.closingToolResult threw: no words" },
    });
  });

  it.each([
    {
      problem: "a Closing Tool Result that is not text",
      wording: { ...fakeWording(), closingToolResult: () => 42 as unknown as string },
      wordingFailure: "TranscriptWording.closingToolResult must return a string",
    },
    {
      problem: "an empty Outcome Note",
      wording: { ...fakeWording(), outcomeNote: () => "" },
      wordingFailure: "TranscriptWording.outcomeNote must return a non-empty string or undefined",
    },
    {
      problem: "an Outcome Note that is not text",
      wording: { ...fakeWording(), outcomeNote: () => ({ text: "done" }) as unknown as string },
      wordingFailure: "TranscriptWording.outcomeNote must return a non-empty string or undefined",
    },
  ])("treats $problem as a failure of the wording", async ({ wording, wordingFailure }) => {
    const { transcript, events } = await cancelAtApproval(wording);

    expect(events.at(-1)).toMatchObject({ type: "run_settled", data: { wordingFailure } });
    expect(transcript.every((message) => message.content !== "")).toBe(true);
  });
});
