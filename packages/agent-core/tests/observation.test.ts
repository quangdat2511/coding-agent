import { describe, expect, it } from "bun:test";
import type { AgentState, SessionEvent } from "../src/index.ts";
import { collect, openTestSession, textTurn } from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const answering = { model: { turns: [textTurn("Fixed it.")] } };

describe("observing an Agent Session", () => {
  it("publishes session_started first, at sequence one, stamped by the injected clock", async () => {
    const { session, clock } = openTestSession(answering);
    clock.advance(1_500);

    await session.dispatch({ type: "start", task });
    const [first] = await collect(session.events());

    expect(first).toEqual({
      sessionId: "session-1",
      sequence: 1,
      occurredAt: "2026-10-01T00:00:01.500Z",
      type: "session_started",
      data: { task },
    });
  });

  it("ends with session_settled, carrying the same Agent Result that result() returns", async () => {
    const { session } = openTestSession(answering);

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(events.at(-1)).toMatchObject({
      type: "session_settled",
      sequence: result.lastSequence,
      data: { result },
    });
  });

  it("follows live Session Events from a subscription made before start, ending after session_settled", async () => {
    const { session } = openTestSession(answering);
    const live = collect(session.events());

    await session.dispatch({ type: "start", task });
    const events = await live;

    expect(events[0]?.type).toBe("session_started");
    expect(events.at(-1)?.type).toBe("session_settled");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it("follows live Session Events from a nonzero sequence subscribed before start", async () => {
    const { session } = openTestSession(answering);
    const live = collect(session.events(1));

    await session.dispatch({ type: "start", task });
    const sequences = (await live).map((event) => event.sequence);

    expect(sequences[0]).toBe(2);
    expect(sequences.at(-1)).toBe((await session.result()).lastSequence);
  });

  it("replays exactly the Session Events after any attach point, with no gap and no duplicate", async () => {
    const { session } = openTestSession(answering);
    await session.dispatch({ type: "start", task });
    const { lastSequence } = await session.result();

    for (let after = 0; after <= lastSequence; after += 1) {
      const sequences = (await collect(session.events(after))).map((event) => event.sequence);
      expect(sequences).toEqual(
        Array.from({ length: lastSequence - after }, (_, index) => after + 1 + index),
      );
    }
  });

  it("keeps snapshot() at least as new as every Session Event already delivered", async () => {
    const { session } = openTestSession(answering);
    const observed: { event: SessionEvent; state: AgentState }[] = [];
    const live = (async () => {
      for await (const event of session.events())
        observed.push({ event, state: session.snapshot() });
    })();

    await session.dispatch({ type: "start", task });
    await live;

    for (const { event, state } of observed) {
      expect(state.lastSequence).toBeGreaterThanOrEqual(event.sequence);
    }
    const last = observed.at(-1);
    if (last?.event.type !== "session_settled") throw new Error("expected session_settled last");
    expect(last.state).toMatchObject({
      phase: last.event.data.result.outcome,
      result: last.event.data.result,
    });
  });

  it("terminates only a consumer that throws, leaving other consumers and the session unaffected", async () => {
    const { session } = openTestSession(answering);
    const throwing = (async () => {
      for await (const _ of session.events()) throw new Error("consumer bug");
    })();
    const healthy = collect(session.events());

    await session.dispatch({ type: "start", task });

    await expect(throwing).rejects.toThrow("consumer bug");
    const result = await session.result();
    expect((await healthy).at(-1)).toMatchObject({ type: "session_settled", data: { result } });
  });

  it("never waits for a consumer that stops pulling Session Events", async () => {
    const { session } = openTestSession(answering);
    void (async () => {
      for await (const _ of session.events()) await new Promise(() => {});
    })();

    await session.dispatch({ type: "start", task });

    const result = await session.result();
    expect(session.snapshot()).toMatchObject({ result });
  });

  it.each([-1, 0.5, Number.NaN])("refuses to attach after sequence %p", (afterSequence) => {
    const { session } = openTestSession(answering);

    expect(() => session.events(afterSequence)).toThrow(RangeError);
  });

  it("keeps the Coding Task it was started with when the caller later mutates it", async () => {
    const { session } = openTestSession(answering);
    const mutable = { objective: "Fix the failing test" };

    await session.dispatch({ type: "start", task: mutable });
    mutable.objective = "Delete the repository";

    const [started] = await collect(session.events());
    expect(started?.data).toEqual({ task });
    expect(session.snapshot().task).toEqual(task);
  });

  it("resolves result() only after session_settled is appended", async () => {
    const { session } = openTestSession(answering);
    const atResolution = session.result().then((result) => ({ result, state: session.snapshot() }));

    await session.dispatch({ type: "start", task });
    const { result, state } = await atResolution;

    expect(state).toMatchObject({ lastSequence: result.lastSequence, result });
  });
});
