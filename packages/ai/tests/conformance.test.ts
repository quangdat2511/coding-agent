/**
 * Recorded-fixture conformance suite (CDA-41).
 *
 * Every Model Provider must pass every case in this file. Adding a
 * provider requires only registering it in the PROVIDERS array below — no
 * new test file is needed.
 *
 * Fixtures are replayed at the transport boundary (globalThis.fetch),
 * below the SDK clients, so the full adapter path is exercised. The suite
 * makes no live network call and holds no credential; running it offline
 * passes.
 *
 * ## Recording path
 *
 * Fixtures live under `tests/fixtures/<adapter-family>/` where
 * `adapter-family` is either `anthropic` (for the Anthropic Messages API)
 * or `openai` (for the OpenAI Chat-Completions-compatible API used by
 * Google, OpenAI, OpenRouter, and xAI).
 *
 * To refresh a fixture:
 * 1. Make a live call with the real provider key (outside CI) and capture
 *    the raw SSE body (e.g. with `curl -N --raw` or a custom fetch
 *    interceptor that tees the stream to a file).
 * 2. Save the raw output as the appropriate `.txt` file in `tests/fixtures/`.
 * 3. Commit the updated fixture.
 *
 * The fixture format is plain SSE text: one or more `event:` / `data:`
 * pairs separated by blank lines, exactly as the provider sends them.
 */

import { describe, expect, it } from "bun:test";
import { stream as anthropicStream } from "../src/api/anthropic-responses.ts";
import { stream as googleStream } from "../src/api/google-generate-content.ts";
import { stream as openaiStream } from "../src/api/openai-responses.ts";
import type { Context, Model, ModelCapabilities, ModelStream } from "../src/types.ts";
import {
  loadFixture,
  sseResponse,
  withCapturingFixtureFetch,
  withFixtureFetch,
} from "./fixtures/fixture-fetch.ts";

// ---------------------------------------------------------------------------
// Provider registry
//
// Each entry declares:
//   - id: matches the provider id in the codebase
//   - label: human-readable name for test output
//   - model: a representative Model value (id/name/provider must be valid)
//   - capabilities: the declared ModelCapabilities for this provider×variant
//   - streamFn: the `stream()` function of the adapter under test
//   - fixtureFamily: which fixture directory to use ("anthropic" | "openai")
// ---------------------------------------------------------------------------

type AdapterFamily = "anthropic" | "google" | "openai" | "xai";

interface ProviderEntry {
  id: string;
  label: string;
  model: Model;
  capabilities: ModelCapabilities;
  streamFn: (
    model: Model,
    context: Context,
    options?: { apiKey?: string; signal?: AbortSignal; maxRetries?: number; baseURL?: string },
  ) => ModelStream;
  fixtureFamily: AdapterFamily;
}

// Imported at suite-load time so TypeScript can see them as typed imports.
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  GOOGLE_GENERATE_CONTENT_CAPABILITIES,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
  XAI_CHAT_COMPLETIONS_CAPABILITIES,
} from "../src/capabilities.ts";

const PROVIDERS: ProviderEntry[] = [
  // --- Anthropic (Messages API) ---
  {
    id: "anthropic",
    label: "Anthropic (messages)",
    model: { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
    capabilities: ANTHROPIC_MESSAGES_CAPABILITIES,
    streamFn: anthropicStream,
    fixtureFamily: "anthropic",
  },
  // --- OpenAI (Chat Completions) ---
  {
    id: "openai",
    label: "OpenAI (chat_completions)",
    model: { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
    capabilities: OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
    streamFn: openaiStream,
    fixtureFamily: "openai",
  },
  // --- OpenRouter (Chat Completions-compatible) ---
  {
    id: "openrouter",
    label: "OpenRouter (chat_completions)",
    model: { id: "openai/gpt-4o-mini", name: "GPT-4o mini (OpenRouter)", provider: "openrouter" },
    capabilities: OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
    streamFn: openaiStream,
    fixtureFamily: "openai",
  },
  // --- xAI (Chat Completions-compatible) ---
  {
    id: "xai",
    label: "xAI (chat_completions)",
    model: { id: "grok-3-mini-fast", name: "Grok 3 Mini Fast", provider: "xai" },
    capabilities: XAI_CHAT_COMPLETIONS_CAPABILITIES,
    streamFn: openaiStream,
    fixtureFamily: "xai",
  },
  // --- Google (generateContent, native) ---
  {
    id: "google",
    label: "Google (generate_content)",
    model: { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite", provider: "google" },
    capabilities: GOOGLE_GENERATE_CONTENT_CAPABILITIES,
    streamFn: googleStream,
    fixtureFamily: "google",
  },
];

// ---------------------------------------------------------------------------
// Shared context used by every case
// ---------------------------------------------------------------------------

const BASE_CONTEXT: Context = {
  messages: [{ role: "user", content: "Hello" }],
};

// ---------------------------------------------------------------------------
// Helper: collect all events from a ModelStream into an array
// ---------------------------------------------------------------------------

async function collectEvents(ms: ModelStream) {
  const events = [];
  for await (const ev of ms) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Conformance cases — run for every registered provider
// ---------------------------------------------------------------------------

for (const provider of PROVIDERS) {
  const { label, model, capabilities, streamFn, fixtureFamily } = provider;

  describe(`Conformance: ${label}`, () => {
    // -----------------------------------------------------------------------
    // Case 1: Text streaming
    // -----------------------------------------------------------------------
    it("streams text content and emits turn_end with assembled message", async () => {
      const fixture = sseResponse(loadFixture(`${fixtureFamily}/text-streaming.txt`));

      await withFixtureFetch(fixture, async () => {
        const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key" });
        const events = await collectEvents(ms);

        // Must have stream_start, at least one content_block_delta, and turn_end
        expect(events.some((e) => e.type === "stream_start")).toBe(true);
        expect(events.some((e) => e.type === "content_block_delta")).toBe(true);

        const turnEnd = events.find((e) => e.type === "turn_end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type === "turn_end") {
          const texts = turnEnd.message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("");
          expect(texts).toBe("Hello, world!");
          expect(turnEnd.message.model).toBe(model.id);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Case 2: Complete Tool Call with arguments
    // -----------------------------------------------------------------------
    it("delivers a complete Tool Call with its arguments reaching the caller", async () => {
      const fixture = sseResponse(loadFixture(`${fixtureFamily}/tool-call.txt`));

      await withFixtureFetch(fixture, async () => {
        const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key" });
        const events = await collectEvents(ms);

        const turnEnd = events.find((e) => e.type === "turn_end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type === "turn_end") {
          const toolCalls = turnEnd.message.content.filter((b) => b.type === "tool_call");
          expect(toolCalls.length).toBeGreaterThanOrEqual(1);
          const toolCall = toolCalls[0];
          if (toolCall?.type === "tool_call") {
            expect(toolCall.name).toBe("get_weather");
            // Arguments arrive as a string (JSON); caller parses, adapter does not.
            expect(typeof toolCall.arguments).toBe("string");
            expect(toolCall.arguments.length).toBeGreaterThan(0);
            // The assembled JSON must be valid and contain the expected city.
            const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
            expect(parsed.city).toBe("Tokyo");
          }
        }
      });
    });

    // -----------------------------------------------------------------------
    // Case 3: Malformed tool argument payload reaches caller unparsed
    // -----------------------------------------------------------------------
    it("delivers a malformed tool argument payload to the caller as a raw string (unparsed)", async () => {
      const fixture = sseResponse(loadFixture(`${fixtureFamily}/tool-call-malformed-args.txt`));

      await withFixtureFetch(fixture, async () => {
        const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key" });
        const events = await collectEvents(ms);

        const turnEnd = events.find((e) => e.type === "turn_end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type === "turn_end") {
          const toolCalls = turnEnd.message.content.filter((b) => b.type === "tool_call");
          expect(toolCalls.length).toBeGreaterThanOrEqual(1);
          const toolCall = toolCalls[0];
          if (toolCall?.type === "tool_call") {
            // The adapter must NOT parse or validate — raw string only.
            expect(typeof toolCall.arguments).toBe("string");
            // It is not valid JSON, so JSON.parse must throw.
            expect(() => JSON.parse(toolCall.arguments)).toThrow();
          }
        }
      });
    });

    // -----------------------------------------------------------------------
    // Case 4: Finish reasons with the raw provider value preserved
    // -----------------------------------------------------------------------
    it("maps a max-output-tokens finish reason and preserves rawReason", async () => {
      const fixtureName =
        fixtureFamily === "anthropic" || fixtureFamily === "google"
          ? `${fixtureFamily}/finish-reason-max-tokens.txt`
          : `${fixtureFamily}/finish-reason-length.txt`;
      const fixture = sseResponse(loadFixture(fixtureName));

      await withFixtureFetch(fixture, async () => {
        const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key" });
        const events = await collectEvents(ms);

        const turnEnd = events.find((e) => e.type === "turn_end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type === "turn_end") {
          expect(turnEnd.message.finishReason.reason).toBe("max_output_tokens");
          // rawReason must be the provider's original string, not the normalized one.
          expect(turnEnd.message.finishReason.rawReason).not.toBe("max_output_tokens");
          expect(typeof turnEnd.message.finishReason.rawReason).toBe("string");
          expect(turnEnd.message.finishReason.rawReason.length).toBeGreaterThan(0);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Case 5: Usage totals
    // -----------------------------------------------------------------------
    it("reports usage totals (inputTokens and outputTokens)", async () => {
      const fixture = sseResponse(loadFixture(`${fixtureFamily}/usage-totals.txt`));

      await withFixtureFetch(fixture, async () => {
        const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key" });
        const events = await collectEvents(ms);

        const turnEnd = events.find((e) => e.type === "turn_end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type === "turn_end") {
          expect(turnEnd.message.usage).toBeDefined();
          expect(typeof turnEnd.message.usage?.inputTokens).toBe("number");
          expect(typeof turnEnd.message.usage?.outputTokens).toBe("number");
          expect(turnEnd.message.usage?.inputTokens).toBe(100);
          expect(turnEnd.message.usage?.outputTokens).toBe(42);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Case 6: Abort — signal already aborted when stream() is called
    // -----------------------------------------------------------------------
    it("emits an error event when the AbortSignal is already aborted", async () => {
      const controller = new AbortController();
      // Abort before stream() is even called.
      controller.abort();

      const fixture = sseResponse(loadFixture(`${fixtureFamily}/text-streaming.txt`));

      await withFixtureFetch(
        (req) => {
          // Verify that the adapter passed controller.signal down to the transport request.
          // If the adapter dropped or ignored the signal, req.signal is not aborted,
          // so we return the success fixture instead of aborting. This will cause turn_end
          // to be emitted and result() to resolve, which fails the test assertions below.
          if (req.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return fixture;
        },
        async () => {
          const ms = streamFn(model, BASE_CONTEXT, {
            apiKey: "test-key",
            signal: controller.signal,
          });
          const events = await collectEvents(ms);

          // Adapter must surface the abort as an error event, not throw uncaught.
          const errorEvent = events.find((e) => e.type === "error");
          expect(errorEvent).toBeDefined();
          // No turn_end must appear after an aborted stream.
          expect(events.some((e) => e.type === "turn_end")).toBe(false);
          // result() must reject.
          await expect(ms.result()).rejects.toThrow();
        },
      );
    });

    // -----------------------------------------------------------------------
    // Case 7: Retry — SDK retries only before the stream opens
    // -----------------------------------------------------------------------
    it("retries only before the stream opens (maxRetries=1 triggers exactly one retry on connection failure)", async () => {
      let callCount = 0;

      await withCapturingFixtureFetch(
        (_req) => {
          callCount += 1;
          if (callCount === 1) {
            // First call: simulate a retryable connection error (HTTP 529 / server overload).
            // The SDK should retry once more (maxRetries=1).
            return new Response(
              JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }),
              {
                status: 529,
                headers: { "content-type": "application/json" },
              },
            );
          }
          // Second call: succeed with the fixture.
          return sseResponse(loadFixture(`${fixtureFamily}/text-streaming.txt`));
        },
        async (captured) => {
          const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key", maxRetries: 1 });
          const events = await collectEvents(ms);

          // The SDK retried: exactly 2 fetch calls were made.
          expect(callCount).toBe(2);
          expect(captured.length).toBe(2);

          // Despite the initial failure, the stream succeeded.
          const turnEnd = events.find((e) => e.type === "turn_end");
          expect(turnEnd).toBeDefined();
        },
      );
    });

    // -----------------------------------------------------------------------
    // Case 8: Declared capabilities match observed behaviour
    // -----------------------------------------------------------------------
    it("declares toolArgumentDelivery that matches how arguments arrive", async () => {
      const rawFixture = loadFixture(`${fixtureFamily}/tool-call.txt`);
      const fixture = sseResponse(rawFixture);

      await withFixtureFetch(fixture, async () => {
        const ms = streamFn(model, BASE_CONTEXT, { apiKey: "test-key" });
        const events = await collectEvents(ms);

        const turnEnd = events.find((e) => e.type === "turn_end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type !== "turn_end") return;

        const toolCalls = turnEnd.message.content.filter((b) => b.type === "tool_call");
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        const toolCall = toolCalls[0];
        if (toolCall?.type === "tool_call") {
          expect(typeof toolCall.arguments).toBe("string");
          expect(toolCall.arguments.length).toBeGreaterThan(0);
          expect(JSON.parse(toolCall.arguments)).toEqual({ city: "Tokyo" });
        }

        // Verify that declared toolArgumentDelivery capability matches how the provider
        // delivers arguments in the wire fixture:
        // - "whole": arguments arrive complete in a single chunk (ADR 0006 §2 for xAI / Google)
        // - "streamed": arguments are delivered incrementally across multiple chunks (OpenAI / Anthropic)
        if (capabilities.toolArgumentDelivery === "whole") {
          if (fixtureFamily === "anthropic") {
            const deltaCount = rawFixture
              .split("\n")
              .filter((l) => l.includes("input_json_delta")).length;
            expect(deltaCount).toBeLessThanOrEqual(1);
          } else if (fixtureFamily === "google") {
            // Google delivers tool args as a complete `functionCall.args` object in one SSE chunk.
            const functionCallChunks = rawFixture
              .split("\n")
              .filter((l) => l.includes('"functionCall"'));
            expect(functionCallChunks.length).toBe(1);
          } else {
            const argChunks = rawFixture
              .split("\n")
              .filter((l) => l.includes('"arguments":"') && !l.includes('"arguments":""'));
            expect(argChunks.length).toBe(1);
          }
        } else {
          if (fixtureFamily === "anthropic") {
            const deltaCount = rawFixture
              .split("\n")
              .filter((l) => l.includes("input_json_delta")).length;
            expect(deltaCount).toBeGreaterThan(1);
          } else if (fixtureFamily === "google") {
            const functionCallChunks = rawFixture
              .split("\n")
              .filter((l) => l.includes('"functionCall"'));
            expect(functionCallChunks.length).toBeGreaterThan(1);
          } else {
            const argChunks = rawFixture
              .split("\n")
              .filter((l) => l.includes('"arguments":"') && !l.includes('"arguments":""'));
            expect(argChunks.length).toBeGreaterThan(1);
          }
        }
      });
    });
  });
}
