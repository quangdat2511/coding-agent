import { describe, expect, it } from "bun:test";
import type { AssistantMessage, UsageCost } from "@coding-agent/ai";
import type { UsageTotals } from "../src/result.ts";
import { addUsage, noUsage, usageOf } from "../src/usage.ts";

describe("addUsage", () => {
  it("sums basic token counts", () => {
    const a: UsageTotals = { inputTokens: 100, outputTokens: 50 };
    const b: UsageTotals = { inputTokens: 200, outputTokens: 80 };

    const result = addUsage(a, b);

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(130);
    expect(result.cachedInputTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
    expect(result.reasoningTokens).toBeUndefined();
    expect(result.cost).toBeUndefined();
  });

  it("sums optional token counts when present on either side", () => {
    const a: UsageTotals = {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 20,
      reasoningTokens: 8,
    };
    const b: UsageTotals = {
      inputTokens: 15,
      outputTokens: 10,
      cacheWriteTokens: 30,
    };

    const result = addUsage(a, b);

    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(15);
    expect(result.cachedInputTokens).toBe(20);
    expect(result.cacheWriteTokens).toBe(30);
    expect(result.reasoningTokens).toBe(8);
  });

  it("leaves cost undefined when both operands lack cost", () => {
    const a: UsageTotals = { inputTokens: 10, outputTokens: 5 };
    const b: UsageTotals = { inputTokens: 10, outputTokens: 5 };

    const result = addUsage(a, b);

    expect(result.cost).toBeUndefined();
  });

  it("sums cost components with fallback 0 when only one operand has cost", () => {
    const cost: UsageCost = {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.05,
      cacheWrite: 0.02,
      total: 0.37,
    };
    const a: UsageTotals = { inputTokens: 10, outputTokens: 5, cost };
    const b: UsageTotals = { inputTokens: 10, outputTokens: 5 };

    const result = addUsage(a, b);

    expect(result.cost).toEqual({
      input: 0.1,
      output: 0.2,
      cacheRead: 0.05,
      cacheWrite: 0.02,
      total: 0.37,
    });
  });

  it("sums cost components and totalFromProvider across turns", () => {
    const costA: UsageCost = {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.05,
      cacheWrite: 0.02,
      total: 0.37,
      totalFromProvider: 0.35,
    };
    const costB: UsageCost = {
      input: 0.05,
      output: 0.1,
      cacheRead: 0.01,
      cacheWrite: 0.01,
      total: 0.17,
      totalFromProvider: 0.15,
    };
    const a: UsageTotals = { inputTokens: 10, outputTokens: 5, cost: costA };
    const b: UsageTotals = { inputTokens: 10, outputTokens: 5, cost: costB };

    const result = addUsage(a, b);

    expect(result.cost?.input).toBeCloseTo(0.15, 8);
    expect(result.cost?.output).toBeCloseTo(0.3, 8);
    expect(result.cost?.cacheRead).toBeCloseTo(0.06, 8);
    expect(result.cost?.cacheWrite).toBeCloseTo(0.03, 8);
    expect(result.cost?.total).toBeCloseTo(0.54, 8);
    expect(result.cost?.totalFromProvider).toBeCloseTo(0.5, 8);
  });

  it("does not mutate operands", () => {
    const a: UsageTotals = { inputTokens: 10, outputTokens: 5 };
    const b: UsageTotals = { inputTokens: 20, outputTokens: 10 };
    const snapA = JSON.stringify(a);
    const snapB = JSON.stringify(b);

    addUsage(a, b);

    expect(JSON.stringify(a)).toBe(snapA);
    expect(JSON.stringify(b)).toBe(snapB);
  });

  it("stays unexported from the agent-core package entry point", async () => {
    const core = await import("../src/index.ts");
    expect("addUsage" in core).toBe(false);
  });
});

describe("usageOf", () => {
  it("returns noUsage when message has no usage", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [],
      model: "test",
      finishReason: { reason: "end_turn", rawReason: "end_turn" },
    };

    expect(usageOf(msg)).toEqual(noUsage);
  });

  it("converts message usage to UsageTotals including cacheWriteTokens and cost", () => {
    const cost: UsageCost = {
      input: 0.1,
      output: 0.2,
      cacheRead: 0,
      cacheWrite: 0.05,
      total: 0.35,
    };
    const msg: AssistantMessage = {
      role: "assistant",
      content: [],
      model: "test",
      finishReason: { reason: "end_turn", rawReason: "end_turn" },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 25,
        cost,
      },
    };

    const result = usageOf(msg);

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheWriteTokens).toBe(25);
    expect(result.cost).toEqual(cost);
  });
});
