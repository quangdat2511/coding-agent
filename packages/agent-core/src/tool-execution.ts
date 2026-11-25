import { isRecord, messageOf } from "./guards.ts";
import type { JsonValue } from "./json.ts";
import type { ExecutableTool, ExecuteContext, PreparedCall, ToolOutcome } from "./tool.ts";
import { isToolError } from "./tool-call-preflight.ts";

const MAX_DETAILS_BYTES = 40_960;
const utf8Encoder = new TextEncoder();

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const cloneJsonObject = (
  value: Record<string, unknown>,
  seen: Set<object>,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (seen.has(value)) return undefined;
  seen.add(value);
  const entries: [string, JsonValue][] = [];
  for (const key of Object.keys(value)) {
    const cloned = cloneJsonValue(value[key], seen);
    if (!cloned.ok) return undefined;
    entries.push([key, cloned.value]);
  }
  seen.delete(value);
  return Object.fromEntries(entries);
};

const cloneJsonValue = (
  value: unknown,
  seen: Set<object>,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false } => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value: value === 0 ? 0 : value } : { ok: false };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { ok: false };
    seen.add(value);
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return { ok: false };
      const cloned = cloneJsonValue(value[index], seen);
      if (!cloned.ok) return { ok: false };
      items.push(cloned.value);
    }
    seen.delete(value);
    return { ok: true, value: items };
  }
  if (isPlainObject(value)) {
    const cloned = cloneJsonObject(value, seen);
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
    const cloned = cloneJsonObject(value, new Set());
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
  const truncated = outcome.truncated === undefined ? {} : { truncated: outcome.truncated };
  if (outcome.isError) {
    return {
      isError: true,
      content: outcome.content,
      error: { code: outcome.error.code, message: outcome.error.message },
      ...truncated,
    };
  }
  const details = snapshotDetails(outcome);
  return {
    isError: false,
    content: outcome.content,
    ...truncated,
    ...(details === undefined ? {} : { details }),
  };
}
