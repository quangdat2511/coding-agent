import type { AssistantMessage, UsageCost } from "@coding-agent/ai";
import type { UsageTotals } from "./result.ts";

type OptionalCount = "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens";

export const noUsage: UsageTotals = { inputTokens: 0, outputTokens: 0 };

const sumOptional = (key: OptionalCount, a: UsageTotals, b: UsageTotals) =>
  a[key] === undefined && b[key] === undefined ? {} : { [key]: (a[key] ?? 0) + (b[key] ?? 0) };

const sumCost = (a?: UsageCost, b?: UsageCost): { cost?: UsageCost } => {
  if (a === undefined && b === undefined) return {};
  const hasProviderTotal = a?.totalFromProvider !== undefined || b?.totalFromProvider !== undefined;
  return {
    cost: {
      input: (a?.input ?? 0) + (b?.input ?? 0),
      output: (a?.output ?? 0) + (b?.output ?? 0),
      cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
      cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
      total: (a?.total ?? 0) + (b?.total ?? 0),
      ...(hasProviderTotal
        ? { totalFromProvider: (a?.totalFromProvider ?? 0) + (b?.totalFromProvider ?? 0) }
        : {}),
    },
  };
};

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...sumOptional("cachedInputTokens", a, b),
    ...sumOptional("cacheWriteTokens", a, b),
    ...sumOptional("reasoningTokens", a, b),
    ...sumCost(a.cost, b.cost),
  };
}

export const usageOf = ({ usage }: AssistantMessage): UsageTotals =>
  usage === undefined ? noUsage : addUsage(noUsage, usage);
