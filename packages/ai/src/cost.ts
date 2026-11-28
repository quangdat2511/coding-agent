import type { ModelCost, Usage, UsageCost } from "./types.ts";

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Calculates the UsageCost of a model response's Usage based on ModelCost rates.
 *
 * All rates in ModelCost are in USD per 1,000,000 tokens.
 * Keeps full IEEE 754 precision without intermediate rounding.
 * Pure function: never mutates the input usage.
 */
export function calculateCost(
  modelCost: ModelCost | undefined,
  usage: Usage,
): UsageCost | undefined {
  const totalFromProvider = usage.cost?.totalFromProvider;

  if (modelCost === undefined) {
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

  const input = (modelCost.input / TOKENS_PER_MILLION) * (usage.inputTokens ?? 0);
  const output = (modelCost.output / TOKENS_PER_MILLION) * (usage.outputTokens ?? 0);
  const cacheRead = (modelCost.cacheRead / TOKENS_PER_MILLION) * (usage.cachedInputTokens ?? 0);
  const cacheWrite = (modelCost.cacheWrite / TOKENS_PER_MILLION) * (usage.cacheWriteTokens ?? 0);
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
