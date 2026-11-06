import { describe, expect, it } from "bun:test";
import { openTestSession } from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

describe("dispatching commands", () => {
  it("accepts start and returns the sequence of session_started", async () => {
    const { session } = openTestSession();

    expect(await session.dispatch({ type: "start", task })).toEqual({
      accepted: true,
      sequence: 1,
    });
  });

  it("rejects a second start as ALREADY_STARTED", async () => {
    const { session } = openTestSession();
    await session.dispatch({ type: "start", task });

    expect(await session.dispatch({ type: "start", task })).toEqual({
      accepted: false,
      code: "ALREADY_STARTED",
      message: expect.any(String),
    });
  });

  it("handles commands one at a time in dispatch order", async () => {
    const { session } = openTestSession();

    const results = await Promise.all([
      session.dispatch({ type: "start", task }),
      session.dispatch({ type: "start", task: { objective: "Another task" } }),
    ]);

    expect(results.map((result) => result.accepted)).toEqual([true, false]);
    expect(session.snapshot().task).toEqual(task);
  });

  it("rejects an Approval decision while no Approval is pending as INVALID_STATE and emits no Session Event", async () => {
    const { session } = openTestSession();

    expect(
      await session.dispatch({
        type: "resolve_approval",
        approvalId: "approval-1",
        decision: "allow",
      }),
    ).toEqual({
      accepted: false,
      code: "INVALID_STATE",
      message: expect.any(String),
    });
    expect(session.snapshot()).toMatchObject({ phase: "ready", lastSequence: 0 });
  });

  it("rejects cancel after the Agent Session settles as ALREADY_SETTLED and emits no Session Event", async () => {
    const { session } = openTestSession();
    await session.dispatch({ type: "start", task });
    const { lastSequence } = await session.result();

    expect(await session.dispatch({ type: "cancel" })).toEqual({
      accepted: false,
      code: "ALREADY_SETTLED",
      message: expect.any(String),
    });
    expect(session.snapshot().lastSequence).toBe(lastSequence);
  });
});
