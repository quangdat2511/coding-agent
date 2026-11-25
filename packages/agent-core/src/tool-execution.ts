import { isRecord, messageOf } from "./guards.ts";
import type { JsonValue } from "./json.ts";
import type { ExecutableTool, ExecuteContext, PreparedCall, ToolOutcome } from "./tool.ts";
import { isToolError } from "./tool-call-preflight.ts";

const MAX_DETAILS_BYTES = 40_960;
const utf8Encoder = new TextEncoder();

interface ByteBudget {
  bytes: number;
}

// Adds a conservative lower bound on serialized UTF-8 bytes and returns false once the 40 KiB
// budget is exceeded, stopping traversal early on huge or deeply shared DAG payloads.
const chargeBytes = (budget: ByteBudget, minBytes: number): boolean => {
  budget.bytes += minBytes;
  return budget.bytes <= MAX_DETAILS_BYTES;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const cloneJsonObject = (
  value: Record<string, unknown>,
  seen: Set<object>,
  budget: ByteBudget,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (seen.has(value)) return undefined;
  const keys = Object.keys(value);
  // Minimum bytes for "{}" plus separating commas.
  if (!chargeBytes(budget, 2 + Math.max(0, keys.length - 1))) return undefined;
  seen.add(value);
  const entries: [string, JsonValue][] = [];
  for (const key of keys) {
    // Minimum bytes for `"<key>":` (each UTF-16 code unit encodes to at least 1 UTF-8 byte).
    if (!chargeBytes(budget, key.length + 3)) return undefined;
    const cloned = cloneJsonValue(value[key], seen, budget);
    if (!cloned.ok) return undefined;
    entries.push([key, cloned.value]);
  }
  seen.delete(value);
  return Object.fromEntries(entries);
};

const cloneJsonValue = (
  value: unknown,
  seen: Set<object>,
  budget: ByteBudget,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false } => {
  if (value === null) {
    return chargeBytes(budget, 4) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === "boolean") {
    return chargeBytes(budget, value ? 4 : 5) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === "string") {
    // Quotes plus at least 1 UTF-8 byte per UTF-16 code unit (surrogate pairs are 2 -> 4 bytes).
    return chargeBytes(budget, value.length + 2) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false };
    const normalized = value === 0 ? 0 : value;
    return chargeBytes(budget, String(normalized).length)
      ? { ok: true, value: normalized }
      : { ok: false };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { ok: false };
    // Minimum bytes for "[]" plus separating commas.
    if (!chargeBytes(budget, 2 + Math.max(0, value.length - 1))) return { ok: false };
    seen.add(value);
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return { ok: false };
      const cloned = cloneJsonValue(value[index], seen, budget);
      if (!cloned.ok) return { ok: false };
      items.push(cloned.value);
    }
    seen.delete(value);
    return { ok: true, value: items };
  }
  if (isPlainObject(value)) {
    const cloned = cloneJsonObject(value, seen, budget);
    return cloned === undefined ? { ok: false } : { ok: true, value: cloned };
  }
  return { ok: false };
};

// Reads, validates, and snapshots outcome.details, dropping invalid or > 40 KiB UTF-8 payloads
// without ever throwing or failing the tool call.
const snapshotDetails = (
  outcome: Extract<ToolOutcome, { isError: false }>,
): Readonly<Record<string, JsonValue>> | undefined => {
  try {
    const value: unknown = outcome.details;
    if (value === undefined || !isPlainObject(value)) return undefined;
    const cloned = cloneJsonObject(value, new Set(), { bytes: 0 });
    if (cloned === undefined) return undefined;
    const serialized = JSON.stringify(cloned);
    if (utf8Encoder.encode(serialized).byteLength > MAX_DETAILS_BYTES) return undefined;
    return cloned;
  } catch {
    return undefined;
  }
};

const isToolOutcome = (outcome: unknown): outcome is ToolOutcome =>
  isRecord(outcome) &&
  typeof outcome.content === "string" &&
  (outcome.truncated === undefined || typeof outcome.truncated === "boolean") &&
  (outcome.isError === false || (outcome.isError === true && isToolError(outcome.error)));

const unexpected = (toolName: string, detail: string): ToolOutcome => {
  const message = `${toolName} failed unexpectedly while executing the call: ${detail}`;
  return { isError: true, content: message, error: { code: "TOOL_INTERNAL_ERROR", message } };
};

export async function executeTool(
  tool: ExecutableTool,
  prepared: PreparedCall,
  ctx: ExecuteContext,
): Promise<ToolOutcome> {
  let outcome: unknown;
  try {
    outcome = await tool.execute(prepared, ctx);
  } catch (error) {
    return unexpected(tool.name, messageOf(error));
  }
  if (!isToolOutcome(outcome)) return unexpected(tool.name, "execute returned an unusable outcome");
  const content = outcome.content;
  const truncated = outcome.truncated === undefined ? {} : { truncated: outcome.truncated };
  if (outcome.isError) {
    return {
      isError: true,
      content,
      error: { code: outcome.error.code, message: outcome.error.message },
      ...truncated,
    };
  }
  const details = snapshotDetails(outcome);
  return {
    isError: false,
    content,
    ...truncated,
    ...(details === undefined ? {} : { details }),
  };
}
