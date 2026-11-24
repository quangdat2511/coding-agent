import { describe, expect, it } from "bun:test";
import { openTestRun } from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

describe("dispatching commands", () => {
  it("accepts start and returns the sequence of run_started", async () => {
    const { run } = openTestRun();

    expect(await run.dispatch({ type: "start", task })).toEqual({
      accepted: true,
      sequence: 1,
    });
  });

  it("rejects a second start as ALREADY_STARTED", async () => {
    const { run } = openTestRun();
    await run.dispatch({ type: "start", task });

    expect(await run.dispatch({ type: "start", task })).toEqual({
      accepted: false,
      code: "ALREADY_STARTED",
      message: expect.any(String),
    });
  });

  it("handles commands one at a time in dispatch order", async () => {
    const { run } = openTestRun();

    const results = await Promise.all([
      run.dispatch({ type: "start", task }),
      run.dispatch({ type: "start", task: { objective: "Another task" } }),
    ]);

    expect(results.map((result) => result.accepted)).toEqual([true, false]);
    expect(run.snapshot().task).toEqual(task);
  });

  it("rejects an Approval decision while no Approval is pending as INVALID_STATE and emits no Run Event", async () => {
    const { run } = openTestRun();

    expect(
      await run.dispatch({
        type: "resolve_approval",
        approvalId: "approval-1",
        decision: "allow",
      }),
    ).toEqual({
      accepted: false,
      code: "INVALID_STATE",
      message: expect.any(String),
    });
    expect(run.snapshot()).toMatchObject({ phase: "ready", lastSequence: 0 });
  });

  it("rejects cancel after the Agent Run settles as ALREADY_SETTLED and emits no Run Event", async () => {
    const { run } = openTestRun();
    await run.dispatch({ type: "start", task });
    const { lastSequence } = await run.result();

    expect(await run.dispatch({ type: "cancel" })).toEqual({
      accepted: false,
      code: "ALREADY_SETTLED",
      message: expect.any(String),
    });
    expect(run.snapshot().lastSequence).toBe(lastSequence);
  });
});
