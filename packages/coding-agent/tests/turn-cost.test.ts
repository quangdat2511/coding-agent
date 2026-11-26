import { describe, expect, it } from "bun:test";
import type { RunEvent, UsageTotals } from "@coding-agent/agent-core";
import type { UsageCost } from "@coding-agent/ai";
import { accumulateTurnCost, calculateTurnCost, collectTurnCost } from "../src/turn-cost.ts";

describe("calculateTurnCost", () => {
  it("calculates turn cost using totalFromProvider when present", () => {
    const cost: UsageCost = {
      input: 0.2,
      output: 0.5,
      cacheRead: 0.04,
      cacheWrite: 0.025,
      total: 0.765,
      totalFromProvider: 0.5,
    };
    const usage: UsageTotals = {
      inputTokens: 100,
      outputTokens: 50,
      cost,
    };

    const result = calculateTurnCost(usage);
    expect(result).toEqual({ known: true, costUsd: 0.5 });
  });

  it("calculates turn cost using catalog total when totalFromProvider is absent", () => {
    const cost: UsageCost = {
      input: 0.2,
      output: 0.5,
      cacheRead: 0.04,
      cacheWrite: 0.025,
      total: 0.765,
    };
    const usage: UsageTotals = {
      inputTokens: 100,
      outputTokens: 50,
      cost,
    };

    const result = calculateTurnCost(usage);
    expect(result).toEqual({ known: true, costUsd: 0.765 });
  });

  it("returns unknown when tokens > 0 and no cost exists", () => {
    const usage: UsageTotals = {
      inputTokens: 100,
      outputTokens: 50,
    };

    const result = calculateTurnCost(usage);
    expect(result).toEqual({ known: false });
  });

  it("returns unknown when only reasoning tokens > 0 and no cost exists", () => {
    const usage: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 50,
    };

    const result = calculateTurnCost(usage);
    expect(result).toEqual({ known: false });
  });

  it("returns known $0 when turn has zero tokens and no cost (noUsage)", () => {
    const usage: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
    };

    const result = calculateTurnCost(usage);
    expect(result).toEqual({ known: true, costUsd: 0 });
  });
});

describe("accumulateTurnCost", () => {
  it("adds known turn cost to previous sum", () => {
    const cost: UsageCost = {
      input: 0.1,
      output: 0.1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.2,
    };
    const usage: UsageTotals = { inputTokens: 10, outputTokens: 10, cost };

    expect(accumulateTurnCost(0.5, usage)).toBe(0.7);
  });

  it("turns accumulated cost to undefined when turn cost is unknown", () => {
    const usage: UsageTotals = { inputTokens: 10, outputTokens: 10 };

    expect(accumulateTurnCost(0.5, usage)).toBeUndefined();
  });

  it("keeps accumulated cost undefined once it becomes unknown", () => {
    const cost: UsageCost = {
      input: 0.1,
      output: 0.1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.2,
    };
    const usage: UsageTotals = { inputTokens: 10, outputTokens: 10, cost };

    expect(accumulateTurnCost(undefined, usage)).toBeUndefined();
  });

  it("keeps accumulated cost known when turn has noUsage", () => {
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0 };

    expect(accumulateTurnCost(0.5, usage)).toBe(0.5);
  });
});

describe("collectTurnCost", () => {
  function turnCompletedEvent(sequence: number, usage: UsageTotals): RunEvent {
    return {
      runId: "run-1",
      sequence,
      occurredAt: "2026-11-26T00:00:00.000Z",
      type: "model_turn_completed",
      data: {
        modelTurnId: `turn-${sequence}`,
        outcome: "completed",
        usage,
      },
    };
  }

  it("sums cost across completed model turns", async () => {
    async function* events(): AsyncIterable<RunEvent> {
      yield turnCompletedEvent(1, {
        inputTokens: 100,
        outputTokens: 50,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.03,
        },
      });
      yield turnCompletedEvent(2, {
        inputTokens: 200,
        outputTokens: 100,
        cost: {
          input: 0.02,
          output: 0.04,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.06,
        },
      });
    }

    const total = await collectTurnCost(events());
    expect(total).toBeCloseTo(0.09, 8);
  });

  it("returns undefined if any turn with tokens lacks cost", async () => {
    async function* events(): AsyncIterable<RunEvent> {
      yield turnCompletedEvent(1, {
        inputTokens: 100,
        outputTokens: 50,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.03,
        },
      });
      yield turnCompletedEvent(2, {
        inputTokens: 200,
        outputTokens: 100,
      });
    }

    const total = await collectTurnCost(events());
    expect(total).toBeUndefined();
  });
});
