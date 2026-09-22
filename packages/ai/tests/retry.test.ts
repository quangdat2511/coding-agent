import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { stream as anthropicStream } from "@/api/anthropic-responses";
import { stream as openaiStream } from "@/api/openai-responses";
import type { Context, Model, ModelStream, ModelStreamEvent, StreamOptions } from "@/types";
import { sanitizeMaxRetries } from "@/utils/retry";

type FetchHandler = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

let currentHandler: FetchHandler | undefined;
const originalFetch = globalThis.fetch;
let fetchSpy: { mockRestore: () => void } | undefined;

beforeAll(() => {
  fetchSpy = (
    spyOn(globalThis, "fetch") as unknown as {
      mockImplementation: (
        fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
      ) => { mockRestore: () => void };
    }
  ).mockImplementation(async (url, init) => {
    if (currentHandler) {
      return currentHandler(url, init);
    }
    return originalFetch(url, init);
  });
});

afterEach(() => {
  currentHandler = undefined;
});

afterAll(() => {
  fetchSpy?.mockRestore();
});

describe("sanitizeMaxRetries", () => {
  it("defaults undefined, null, NaN, and Infinity to 0", () => {
    expect(sanitizeMaxRetries(undefined)).toBe(0);
    expect(sanitizeMaxRetries(null as unknown as number)).toBe(0);
    expect(sanitizeMaxRetries(Number.NaN)).toBe(0);
    expect(sanitizeMaxRetries(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sanitizeMaxRetries(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("clamps negative numbers to 0", () => {
    expect(sanitizeMaxRetries(-1)).toBe(0);
    expect(sanitizeMaxRetries(-100)).toBe(0);
  });

  it("floors positive floating point numbers", () => {
    expect(sanitizeMaxRetries(2.7)).toBe(2);
    expect(sanitizeMaxRetries(0.9)).toBe(0);
  });

  it("preserves valid non-negative integers", () => {
    expect(sanitizeMaxRetries(0)).toBe(0);
    expect(sanitizeMaxRetries(1)).toBe(1);
    expect(sanitizeMaxRetries(5)).toBe(5);
  });
});

const anthropicModel: Model = {
  id: "claude-3-5-sonnet",
  name: "Claude 3.5 Sonnet",
  provider: "anthropic",
};

const openaiModel: Model = {
  id: "gpt-4o",
  name: "GPT-4o",
  provider: "openai",
};

const context: Context = {
  messages: [{ role: "user", content: "Hello" }],
};

function createServerErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "Internal server error" },
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
        "retry-after": "0.001",
      },
    },
  );
}

function createUnauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "Invalid API key" },
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function createAnthropicSseStream(text = "Hello"): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });
}

function createAnthropicBrokenStream(errorMessage: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Emit initial stream event
      controller.enqueue(
        encoder.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        ),
      );
      // Drop connection mid-flight
      controller.error(new Error(errorMessage));
    },
  });
}

function createOpenAiSseStream(text = "Hello"): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":12345,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":12345,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":12345,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function createOpenAiBrokenStream(errorMessage: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Emit initial chunk
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":12345,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        ),
      );
      // Drop connection mid-flight
      controller.error(new Error(errorMessage));
    },
  });
}

async function collectEvents(
  streamIterable: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of streamIterable) {
    events.push(event);
  }
  return events;
}

interface ProviderConformanceConfig {
  name: string;
  stream: (model: Model, context: Context, options?: StreamOptions) => ModelStream;
  model: Model;
  createSseStream: (text?: string) => ReadableStream<Uint8Array>;
  createBrokenStream: (errorMessage: string) => ReadableStream<Uint8Array>;
  droppedErrorMessage: string;
}

const conformanceProviders: ProviderConformanceConfig[] = [
  {
    name: "Anthropic SDK",
    stream: anthropicStream,
    model: anthropicModel,
    createSseStream: createAnthropicSseStream,
    createBrokenStream: createAnthropicBrokenStream,
    droppedErrorMessage: "Anthropic connection dropped mid-flight",
  },
  {
    name: "OpenAI SDK",
    stream: openaiStream,
    model: openaiModel,
    createSseStream: createOpenAiSseStream,
    createBrokenStream: createOpenAiBrokenStream,
    droppedErrorMessage: "OpenAI connection dropped mid-flight",
  },
];

for (const {
  name,
  stream,
  model,
  createSseStream,
  createBrokenStream,
  droppedErrorMessage,
} of conformanceProviders) {
  describe(`Transport Retry Conformance: ${name}`, () => {
    it("retries failed requests before stream opens up to caller-set bound (maxRetries: 2 -> 3 attempts) and rejects", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createServerErrorResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: 2,
      });

      const events = await collectEvents(streamObj);

      // 1 initial request + 2 retries = 3 calls
      expect(callCount).toBe(3);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });

    it("accepts maxRetries: 0 and fails immediately with exactly 1 attempt before stream opens", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createServerErrorResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: 0,
      });

      const events = await collectEvents(streamObj);

      expect(callCount).toBe(1);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });

    it("defaults maxRetries to 0 when omitted, failing immediately with exactly 1 attempt", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createServerErrorResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
      });

      const events = await collectEvents(streamObj);

      // Verifies client does NOT use SDK default of 2 retries
      expect(callCount).toBe(1);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });

    it("succeeds when a request fails before stream opens but succeeds on retry", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        if (callCount === 1) {
          return createServerErrorResponse();
        }
        return new Response(createSseStream("Recovered"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: 2,
      });

      const events = await collectEvents(streamObj);

      expect(callCount).toBe(2);
      expect(events.some((e) => e.type === "error")).toBe(false);
      const turnEnd = events.find((e) => e.type === "turn_end");
      expect(turnEnd).toBeDefined();
      const result = await streamObj.result();
      expect(result.content).toEqual([{ type: "text", text: "Recovered" }]);
    });

    it("never retries after the first stream event is emitted, whatever the bound", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return new Response(createBrokenStream(droppedErrorMessage), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: 2,
      });

      const events = await collectEvents(streamObj);

      // Never retried after the first stream event: fetch called exactly once
      expect(callCount).toBe(1);
      expect(events.some((e) => e.type === "stream_start")).toBe(true);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow(droppedErrorMessage);
    });

    it("does not retry non-retryable 4xx errors (e.g. 401 Unauthorized) even with maxRetries: 3", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createUnauthorizedResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: 3,
      });

      const events = await collectEvents(streamObj);

      expect(callCount).toBe(1);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });

    it("clamps negative maxRetries to 0, failing immediately with exactly 1 attempt", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createServerErrorResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: -1,
      });

      const events = await collectEvents(streamObj);

      expect(callCount).toBe(1);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });

    it("floors floating-point maxRetries (e.g. 1.8 -> 1 retry, 2 attempts)", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createServerErrorResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: 1.8,
      });

      const events = await collectEvents(streamObj);

      // 1 initial + 1 retry = 2 calls
      expect(callCount).toBe(2);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });

    it("safely treats NaN maxRetries as 0 without throwing integer validation errors", async () => {
      let callCount = 0;
      currentHandler = async () => {
        callCount++;
        return createServerErrorResponse();
      };

      const streamObj = stream(model, context, {
        apiKey: "test-key",
        maxRetries: Number.NaN,
      });

      const events = await collectEvents(streamObj);

      expect(callCount).toBe(1);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      await expect(streamObj.result()).rejects.toThrow();
    });
  });
}
