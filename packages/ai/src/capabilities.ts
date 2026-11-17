import type { ModelCapabilities } from "./types.ts";

// ---------------------------------------------------------------------------
// Default capabilities per (Provider × API Variant)
//
// Capabilities follow the API a provider speaks, not the provider identity.
// The same wire format can differ between providers (xAI's Chat Completions
// endpoint delivers tool arguments whole while OpenAI streams them), so
// neither the provider nor the variant alone is enough.
//
// Per-model overrides exist only where a model genuinely differs from its
// variant default. Adding capability fields to the model catalog JSON files
// is rejected: those rows rot silently (ADR 0006 §2).
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages API (Claude models via `@anthropic-ai/sdk`).
 *
 * - `usageTiming: "incremental"` — Anthropic is confirmed to stream usage
 *   progressively (partial at `message_start`, cumulative on each `message_delta`,
 *   and final at `message_stop`).
 */
export const ANTHROPIC_MESSAGES_CAPABILITIES: ModelCapabilities = Object.freeze({
  parallelToolCallControl: true,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "streamed",
  usageTiming: "incremental",
  serverSideTools: false,
});

/** OpenAI Chat Completions API (GPT / o-series via `openai` SDK). */
export const OPENAI_CHAT_COMPLETIONS_CAPABILITIES: ModelCapabilities = Object.freeze({
  parallelToolCallControl: true,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "streamed",
  usageTiming: "final",
  serverSideTools: false,
});

/**
 * Google `generateContent` API (Gemini models).
 *
 * - `parallelToolCallControl: false` — the API does not expose a flag to
 *   disable parallel tool calls.
 * - `toolArgumentDelivery: "whole"` — function call arguments arrive as a
 *   complete JSON object, not streamed fragments.
 * - `serverSideTools: true` — supports server-side tools such as code
 *   execution and Google Search grounding.
 */
export const GOOGLE_GENERATE_CONTENT_CAPABILITIES: ModelCapabilities = Object.freeze({
  parallelToolCallControl: false,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "whole",
  usageTiming: "final",
  serverSideTools: true,
});

/** OpenRouter Chat Completions API (proxies multiple upstream providers). */
export const OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES: ModelCapabilities = Object.freeze({
  parallelToolCallControl: true,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "streamed",
  usageTiming: "final",
  serverSideTools: false,
});

/**
 * xAI Chat Completions API (Grok models).
 *
 * - `toolArgumentDelivery: "whole"` — xAI's Chat-Completions-compatible
 *   endpoint delivers tool arguments whole (ADR 0006 §2).
 */
export const XAI_CHAT_COMPLETIONS_CAPABILITIES: ModelCapabilities = Object.freeze({
  parallelToolCallControl: true,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "whole",
  usageTiming: "final",
  serverSideTools: false,
});

/**
 * OpenCode Go Chat Completions gateway (ADR 0007), serving DeepSeek V4.1 Flash.
 *
 * - `parallelToolCallControl: false` — the gateway accepts `parallel_tool_calls` (HTTP 200) but
 *   nothing shows it honours the flag, so it is not declared. Agent Core handles several Tool
 *   Calls in one Model Turn.
 * - `toolArgumentDelivery: "streamed"` — arguments arrive as several `arguments` fragments
 *   (recorded fixture `opencode/tool-call.txt`).
 * - `usageTiming: "final"` — usage arrives once, in the chunk that carries the finish reason.
 */
export const OPENCODE_GO_CHAT_COMPLETIONS_CAPABILITIES: ModelCapabilities = Object.freeze({
  parallelToolCallControl: false,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "streamed",
  usageTiming: "final",
  serverSideTools: false,
});

// ---------------------------------------------------------------------------
// Per-model override mechanism & shared attacher
// ---------------------------------------------------------------------------

/**
 * Returns a new frozen `ModelCapabilities` by shallow-merging partial overrides onto
 * the variant defaults. Used only where a specific model genuinely differs
 * from its variant default.
 */
export function withModelOverrides(
  defaults: ModelCapabilities,
  overrides: Partial<ModelCapabilities>,
): ModelCapabilities {
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([_, value]) => value !== undefined),
  );
  return Object.freeze({ ...defaults, ...definedOverrides });
}

/**
 * Attaches default capabilities to a list of models, applying optional
 * per-model overrides where specified.
 *
 * The generic `T` preserves the full shape of the input model objects, and
 * the intersection `T & { capabilities: ModelCapabilities }` guarantees that
 * callers can access `capabilities` without an `undefined` guard — the type
 * system now reflects the runtime guarantee that every model returned by this
 * function always has a `capabilities` object.
 */
export function applyCapabilities<T extends { id: string; name: string; provider: string }>(
  models: readonly T[],
  defaultCapabilities: ModelCapabilities,
  overrides?: Record<string, Partial<ModelCapabilities>>,
): (T & { capabilities: ModelCapabilities })[] {
  return models.map((m) => {
    const modelOverride = overrides?.[m.id];
    const capabilities = modelOverride
      ? withModelOverrides(defaultCapabilities, modelOverride)
      : defaultCapabilities;
    return { ...m, capabilities };
  });
}
