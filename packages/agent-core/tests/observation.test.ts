import { describe, expect, it } from "bun:test";
import type { AgentState, RunEvent } from "../src/index.ts";
import { collect, openTestRun, textTurn } from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const answering = { model: { turns: [textTurn("Fixed it.")] } };

describe("observing an Agent Run", () => {
  it("publishes run_started first, at sequence one, stamped by the injected clock", async () => {
    const { run, clock } = openTestRun(answering);
    clock.advance(1_500);

    await run.dispatch({ type: "start", task });
    const [first] = await collect(run.events());

    expect(first).toEqual({
      runId: "run-1",
      sequence: 1,
      occurredAt: "2026-10-01T00:00:01.500Z",
      type: "run_started",
      data: { task },
    });
  });

  it("ends with run_settled, carrying the same Agent Result that result() returns", async () => {
    const { run } = openTestRun(answering);

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());

    expect(events.at(-1)).toMatchObject({
      type: "run_settled",
      sequence: result.lastSequence,
      data: { result },
    });
  });

  it("follows live Run Events from a subscription made before start, ending after run_settled", async () => {
    const { run } = openTestRun(answering);
    const live = collect(run.events());

    await run.dispatch({ type: "start", task });
    const events = await live;

    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_settled");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it("follows live Run Events from a nonzero sequence subscribed before start", async () => {
    const { run } = openTestRun(answering);
    const live = collect(run.events(1));

    await run.dispatch({ type: "start", task });
    const sequences = (await live).map((event) => event.sequence);

    expect(sequences[0]).toBe(2);
    expect(sequences.at(-1)).toBe((await run.result()).lastSequence);
  });

  it("replays exactly the Run Events after any attach point, with no gap and no duplicate", async () => {
    const { run } = openTestRun(answering);
    await run.dispatch({ type: "start", task });
    const { lastSequence } = await run.result();

    for (let after = 0; after <= lastSequence; after += 1) {
      const sequences = (await collect(run.events(after))).map((event) => event.sequence);
      expect(sequences).toEqual(
        Array.from({ length: lastSequence - after }, (_, index) => after + 1 + index),
      );
    }
  });

  it("keeps snapshot() at least as new as every Run Event already delivered", async () => {
    const { run } = openTestRun(answering);
    const observed: { event: RunEvent; state: AgentState }[] = [];
    const live = (async () => {
      for await (const event of run.events()) observed.push({ event, state: run.snapshot() });
    })();

    await run.dispatch({ type: "start", task });
    await live;

    for (const { event, state } of observed) {
      expect(state.lastSequence).toBeGreaterThanOrEqual(event.sequence);
    }
    const last = observed.at(-1);
    if (last?.event.type !== "run_settled") throw new Error("expected run_settled last");
    expect(last.state).toMatchObject({
      phase: last.event.data.result.outcome,
      result: last.event.data.result,
    });
  });

  it("terminates only a consumer that throws, leaving other consumers and the run unaffected", async () => {
    const { run } = openTestRun(answering);
    const throwing = (async () => {
      for await (const _ of run.events()) throw new Error("consumer bug");
    })();
    const healthy = collect(run.events());

    await run.dispatch({ type: "start", task });

    await expect(throwing).rejects.toThrow("consumer bug");
    const result = await run.result();
    expect((await healthy).at(-1)).toMatchObject({ type: "run_settled", data: { result } });
  });

  it("never waits for a consumer that stops pulling Run Events", async () => {
    const { run } = openTestRun(answering);
    void (async () => {
      for await (const _ of run.events()) await new Promise(() => {});
    })();

    await run.dispatch({ type: "start", task });

    const result = await run.result();
    expect(run.snapshot()).toMatchObject({ result });
  });

  it.each([-1, 0.5, Number.NaN])("refuses to attach after sequence %p", (afterSequence) => {
    const { run } = openTestRun(answering);

    expect(() => run.events(afterSequence)).toThrow(RangeError);
  });

  it("keeps the Coding Task it was started with when the caller later mutates it", async () => {
    const { run } = openTestRun(answering);
    const mutable = { objective: "Fix the failing test" };

    await run.dispatch({ type: "start", task: mutable });
    mutable.objective = "Delete the repository";

    const [started] = await collect(run.events());
    expect(started?.data).toEqual({ task });
    expect(run.snapshot().task).toEqual(task);
  });

  it("resolves result() only after run_settled is appended", async () => {
    const { run } = openTestRun(answering);
    const atResolution = run.result().then((result) => ({ result, state: run.snapshot() }));

    await run.dispatch({ type: "start", task });
    const { result, state } = await atResolution;

    expect(state).toMatchObject({ lastSequence: result.lastSequence, result });
  });
});
