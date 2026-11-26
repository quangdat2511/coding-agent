import type { ModelCost, Usage, UsageCost } from "./types.ts";

/**
 * Calculates the UsageCost of a model response's Usage based on ModelCost rates.
 *
 * All rates in ModelCost are in USD per 1,000,000 tokens.
 * Keeps full IEEE 754 precision without intermediate rounding.
 * Pure function: never mutates the input usage.
 */
export function calculateCost(cost: ModelCost | undefined, usage: Usage): UsageCost | undefined {
  const totalFromProvider = usage.cost?.totalFromProvider;

  if (cost === undefined) {
    if (totalFromProvider !== undefined) {
      return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        totalFromProvider,
      };
    }
    return undefined;
  }

  const input = (cost.input / 1_000_000) * (usage.inputTokens ?? 0);
  const output = (cost.output / 1_000_000) * (usage.outputTokens ?? 0);
  const cacheRead = (cost.cacheRead / 1_000_000) * (usage.cachedInputTokens ?? 0);
  const cacheWrite = (cost.cacheWrite / 1_000_000) * (usage.cacheWriteTokens ?? 0);
  const total = input + output + cacheRead + cacheWrite;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    ...(totalFromProvider !== undefined ? { totalFromProvider } : {}),
  };
}
