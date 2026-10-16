import type { AssistantMessage } from "@coding-agent/ai";
import type { UsageTotals } from "./result.ts";

type OptionalCount = "cachedInputTokens" | "reasoningTokens";

export const noUsage: UsageTotals = { inputTokens: 0, outputTokens: 0 };

const sumOptional = (key: OptionalCount, a: UsageTotals, b: UsageTotals) =>
  a[key] === undefined && b[key] === undefined ? {} : { [key]: (a[key] ?? 0) + (b[key] ?? 0) };

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...sumOptional("cachedInputTokens", a, b),
    ...sumOptional("reasoningTokens", a, b),
  };
}

export const usageOf = ({ usage }: AssistantMessage): UsageTotals =>
  usage === undefined ? noUsage : addUsage(noUsage, usage);
