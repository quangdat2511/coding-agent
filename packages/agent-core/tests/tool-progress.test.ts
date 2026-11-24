import { describe, expect, it } from "bun:test";
import type { ExecutableTool, ExecuteContext, RunEvent, ToolOutcome } from "../src/index.ts";
import {
  collect,
  fakeTool,
  type ManualClock,
  openTestRun,
  textTurn,
  toolCallTurn,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Run the build" };

type Script = (ctx: ExecuteContext, clock: ManualClock) => Promise<void> | void;

// A tool whose execute reports progress as the script says, then returns a fixed outcome.
function progressTool(script: Script, getClock: () => ManualClock): ExecutableTool {
  return {
    ...fakeTool({ name: "build" }),
    async execute(_prepared, ctx): Promise<ToolOutcome> {
      await script(ctx, getClock());
      return { isError: false, content: "built" };
    },
  };
}

// Runs one Tool Call of a progress-reporting tool and returns the events that concern it.
async function runWithProgress(script: Script): Promise<RunEvent[]> {
  let clock: ManualClock | undefined;
  const opened = openTestRun({
    approvalPolicy: "auto-approve",
    tools: [progressTool(script, () => clock as ManualClock)],
    model: {
      turns: [toolCallTurn({ toolCallId: "call-1", name: "build", input: {} }), textTurn("Done.")],
    },
  });
  clock = opened.clock;
  await opened.run.dispatch({ type: "start", task });
  await opened.run.result();
  const events = await collect(opened.run.events());
  return events.filter((event) =>
    ["tool_execution_started", "tool_execution_progress", "tool_call_completed"].includes(
      event.type,
    ),
  );
}

const shape = (events: readonly RunEvent[]) =>
  events.map((event) =>
    event.type === "tool_execution_progress"
      ? { type: event.type, output: event.data.update.output }
      : { type: event.type },
  );

describe("reporting Tool Progress", () => {
  it("delivers a progress update between the start and the completion of its Tool Call", async () => {
    const events = await runWithProgress(({ onProgress }) => {
      onProgress({ output: "compiling 1 of 3\n" });
    });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_execution_progress", output: "compiling 1 of 3\n" },
      { type: "tool_call_completed" },
    ]);
    const progress = events[1] as Extract<RunEvent, { type: "tool_execution_progress" }>;
    expect(progress.data.toolCallId).toBe("tool_call-1");
  });

  it("ignores an update that arrives after the Tool Call completed", async () => {
    let report: ExecuteContext["onProgress"] = () => {};
    const events = await runWithProgress(({ onProgress }) => {
      report = onProgress;
    });
    report({ output: "too late\n" });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_call_completed" },
    ]);
  });

  it("keeps only the last 2 KiB of an update, cut at a character boundary", async () => {
    // "é" is two UTF-8 bytes, so 1,025 of them are 2,050 bytes and a 2,048-byte cut from the end
    // lands inside the first character kept.
    const output = `start\n${"é".repeat(1_025)}`;
    const events = await runWithProgress(({ onProgress }) => {
      onProgress({ output });
    });

    expect(shape(events)[1]).toEqual({
      type: "tool_execution_progress",
      output: "é".repeat(1_024),
    });
  });

  it("delivers at most one update per 250 ms, the newest one when the interval ends", async () => {
    const events = await runWithProgress(({ onProgress }, clock) => {
      onProgress({ output: "line 1\n" });
      clock.advance(50);
      onProgress({ output: "line 1\nline 2\n" });
      clock.advance(50);
      onProgress({ output: "line 1\nline 2\nline 3\n" });
      clock.advance(149);
      expect(clock.monotonicMs()).toBe(249);
      clock.advance(1);
    });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_execution_progress", output: "line 1\n" },
      { type: "tool_execution_progress", output: "line 1\nline 2\nline 3\n" },
      { type: "tool_call_completed" },
    ]);
  });

  it("discards an update still held when the Tool Call completes", async () => {
    const events = await runWithProgress(({ onProgress }, clock) => {
      onProgress({ output: "line 1\n" });
      clock.advance(100);
      onProgress({ output: "line 1\nline 2\n" });
    });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_execution_progress", output: "line 1\n" },
      { type: "tool_call_completed" },
    ]);
  });

  it("delivers an update at once when the interval has already ended", async () => {
    const events = await runWithProgress(({ onProgress }, clock) => {
      onProgress({ output: "linking\n" });
      clock.advance(10_000);
      onProgress({ output: "linking\ndone\n" });
    });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_execution_progress", output: "linking\n" },
      { type: "tool_execution_progress", output: "linking\ndone\n" },
      { type: "tool_call_completed" },
    ]);
  });

  it("drops an update whose output did not change", async () => {
    const events = await runWithProgress(({ onProgress }, clock) => {
      onProgress({ output: "waiting\n" });
      clock.advance(300);
      onProgress({ output: "waiting\n" });
      clock.advance(300);
    });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_execution_progress", output: "waiting\n" },
      { type: "tool_call_completed" },
    ]);
  });

  it("ignores an update that is not Tool Progress", async () => {
    const events = await runWithProgress(({ onProgress }) => {
      (onProgress as (update: unknown) => void)({ message: "old shape" });
      (onProgress as (update: unknown) => void)(null);
    });

    expect(shape(events)).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_call_completed" },
    ]);
  });

  it("delivers no update after cancellation's grace period completes the Tool Call", async () => {
    // The tool ignores the abort, so the grace period expires while execute still runs and the
    // run completes the call and settles without it. The tool then keeps reporting.
    let report: ExecuteContext["onProgress"] = () => {};
    const finished = Promise.withResolvers<ToolOutcome>();
    const stubborn: ExecutableTool = {
      ...fakeTool({ name: "build" }),
      execute(_prepared, ctx) {
        report = ctx.onProgress;
        ctx.onProgress({ output: "line 1\n" });
        return finished.promise;
      },
    };
    const { run, clock } = openTestRun({
      approvalPolicy: "auto-approve",
      tools: [stubborn],
      limits: { cancellationGraceMs: 20 },
      model: { turns: [toolCallTurn({ toolCallId: "call-1", name: "build", input: {} })] },
    });

    await run.dispatch({ type: "start", task });
    await waitForEvent(run, "tool_execution_started");
    await run.dispatch({ type: "cancel" });
    clock.advance(300);
    report({ output: "line 1\nline 2\n" });
    const result = await run.result();
    clock.advance(300);
    report({ output: "line 1\nline 2\nline 3\n" });
    finished.resolve({ isError: false, content: "built" });
    const events = await collect(run.events());

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.failure.code).toBe("CANCELLATION_TIMEOUT");
    const watched = ["tool_execution_started", "tool_execution_progress", "tool_call_completed"];
    expect(shape(events.filter((event) => watched.includes(event.type)))).toEqual([
      { type: "tool_execution_started" },
      { type: "tool_execution_progress", output: "line 1\n" },
      { type: "tool_call_completed" },
    ]);
    expect(events.at(-1)?.type).toBe("run_settled");
    expect(run.snapshot().lastSequence).toBe(result.lastSequence);
  });
});
