/**
 * The HTTP status of a failed request (CDA-83).
 *
 * ADR 0005 §7 makes a trial rerun-eligible when its MODEL_FAILURE records an HTTP 401, 403, 429
 * or 5xx from the provider. The Chat Completions adapter, shared by openai, openrouter, xai and
 * opencode, carries that status on its error event. Responses are replayed at the transport
 * boundary, below the SDK, so its own error classes and retries are exercised.
 */

import { describe, expect, it } from "bun:test";
import { stream } from "../src/api/openai-responses.ts";
import { createProviderDirectory } from "../src/index.ts";
import type { Context, Model, ModelStreamEvent } from "../src/types.ts";
import { withCapturingFixtureFetch } from "./fixtures/fixture-fetch.ts";

const context: Context = { messages: [{ role: "user", content: "Hello" }] };

const model: Model = {
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  provider: "opencode",
};

// The OpenAI SDK waits `retry-after-ms` between attempts; 0 keeps a retried test fast.
const failure = (status: number) =>
  new Response(JSON.stringify({ error: { message: `upstream said ${status}`, type: "error" } }), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "0" },
  });

async function errorOf(events: AsyncIterable<ModelStreamEvent>) {
  for await (const event of events) {
    if (event.type === "error") return event.error;
  }
  throw new Error("the stream ended without an error event");
}

describe("the HTTP status of a failed Chat Completions request", () => {
  it.each([401, 403, 429, 500, 503])("records %i on the error event", async (status) => {
    await withCapturingFixtureFetch(failure(status), async () => {
      const error = await errorOf(stream(model, context, { apiKey: "k", maxRetries: 0 }));

      expect(error.httpStatus).toBe(status);
      expect(error.message).toContain(String(status));
    });
  });

  it("records a 4xx outside the rerun rule too, so the rule decides and not the adapter", async () => {
    await withCapturingFixtureFetch(failure(400), async () => {
      const error = await errorOf(stream(model, context, { apiKey: "k", maxRetries: 0 }));

      expect(error.httpStatus).toBe(400);
    });
  });

  it("records the status of the last attempt when the SDK retries", async () => {
    const statuses = [503, 502, 429];
    await withCapturingFixtureFetch(
      () => failure(statuses.shift() ?? 500),
      async (captured) => {
        const error = await errorOf(stream(model, context, { apiKey: "k", maxRetries: 2 }));

        expect(captured).toHaveLength(3);
        expect(error.httpStatus).toBe(429);
      },
    );
  });

  it("records no status when no HTTP response arrived", async () => {
    await withCapturingFixtureFetch(
      () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        const error = await errorOf(stream(model, context, { apiKey: "k", maxRetries: 0 }));

        expect(error).not.toHaveProperty("httpStatus");
      },
    );
  });

  it("records no status when the stream ends without a finish reason", async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n';
    await withCapturingFixtureFetch(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      async () => {
        const error = await errorOf(stream(model, context, { apiKey: "k", maxRetries: 0 }));

        expect(error).not.toHaveProperty("httpStatus");
      },
    );
  });

  // Every provider whose adapter is openai-responses.ts carries the status. Anthropic and Google
  // have adapters of their own, which do not (stated on ModelStreamEvent's error member).
  it.each([
    ["openai", "gpt-4o-mini"],
    ["openrouter", "openai/gpt-4o-mini"],
    ["xai", "grok-4.3"],
    ["opencode", "deepseek-v4.1-flash"],
  ])("is carried for %s through the provider directory", async (provider, id) => {
    const directory = createProviderDirectory();
    const selected = directory.getModel(provider, id);
    if (selected === undefined) throw new Error(`the ${provider} catalogue lists no ${id}`);

    await withCapturingFixtureFetch(failure(429), async () => {
      const error = await errorOf(
        directory.stream(selected, context, { apiKey: "k", maxRetries: 0 }),
      );

      expect(error.httpStatus).toBe(429);
    });
  });
});
