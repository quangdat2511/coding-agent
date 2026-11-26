import { describe, expect, it } from "bun:test";
import { calculateCost } from "../src/cost.ts";
import type { ModelCost, Usage } from "../src/types.ts";

describe("calculateCost", () => {
  const modelCost: ModelCost = {
    input: 2.0, // $2.00 per 1M tokens
    output: 10.0, // $10.00 per 1M tokens
    cacheRead: 0.2, // $0.20 per 1M tokens
    cacheWrite: 2.5, // $2.50 per 1M tokens
  };

  it("calculates cost components and total for priced usage", () => {
    const usage: Usage = {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedInputTokens: 200_000,
      cacheWriteTokens: 10_000,
    };

    const cost = calculateCost(modelCost, usage);

    expect(cost).toBeDefined();
    expect(cost?.input).toBeCloseTo(0.2, 8); // (2 / 1M) * 100k = 0.2
    expect(cost?.output).toBeCloseTo(0.5, 8); // (10 / 1M) * 50k = 0.5
    expect(cost?.cacheRead).toBeCloseTo(0.04, 8); // (0.2 / 1M) * 200k = 0.04
    expect(cost?.cacheWrite).toBeCloseTo(0.025, 8); // (2.5 / 1M) * 10k = 0.025
    expect(cost?.total).toBeCloseTo(0.765, 8);
    expect(cost?.totalFromProvider).toBeUndefined();
  });

  it("treats missing optional token counts as 0", () => {
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };

    const cost = calculateCost(modelCost, usage);

    expect(cost).toBeDefined();
    expect(cost?.input).toBe(2.0);
    expect(cost?.output).toBe(10.0);
    expect(cost?.cacheRead).toBe(0);
    expect(cost?.cacheWrite).toBe(0);
    expect(cost?.total).toBe(12.0);
  });

  it("returns undefined when modelCost is undefined and no totalFromProvider exists", () => {
    const usage: Usage = {
      inputTokens: 100,
      outputTokens: 50,
    };

    expect(calculateCost(undefined, usage)).toBeUndefined();
  });

  it("returns zero components and keeps totalFromProvider when modelCost is undefined", () => {
    const usage: Usage = {
      inputTokens: 100,
      outputTokens: 50,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        totalFromProvider: 0.042,
      },
    };

    const cost = calculateCost(undefined, usage);

    expect(cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      totalFromProvider: 0.042,
    });
  });

  it("calculates catalog total while preserving totalFromProvider when both are present", () => {
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        totalFromProvider: 1.5,
      },
    };

    const cost = calculateCost(modelCost, usage);

    expect(cost?.input).toBe(2.0);
    expect(cost?.output).toBe(0);
    expect(cost?.total).toBe(2.0);
    expect(cost?.totalFromProvider).toBe(1.5);
  });

  it("never mutates the input usage object", () => {
    const usage: Usage = {
      inputTokens: 100,
      outputTokens: 200,
    };
    const usageSnapshot = JSON.stringify(usage);

    calculateCost(modelCost, usage);

    expect(JSON.stringify(usage)).toBe(usageSnapshot);
  });

  it("preserves full IEEE 754 precision without intermediate rounding", () => {
    const usage: Usage = {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 1,
      cacheWriteTokens: 1,
    };

    const cost = calculateCost(modelCost, usage);

    expect(cost).toBeDefined();
    expect(cost?.input).toBe(2.0 / 1_000_000);
    expect(cost?.output).toBe(10.0 / 1_000_000);
    expect(cost?.cacheRead).toBe(0.2 / 1_000_000);
    expect(cost?.cacheWrite).toBe(2.5 / 1_000_000);
    expect(cost?.total).toBe((2.0 + 10.0 + 0.2 + 2.5) / 1_000_000);
  });
});
