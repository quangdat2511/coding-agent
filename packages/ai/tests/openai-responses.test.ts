import { describe, expect, it, mock } from "bun:test";
import { collectTurnEndEvent } from "@tests/test-utils";
import type { Context, Model } from "@/types";

type OpenAIStreamChunk = {
  choices: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
};

let mockChunks: OpenAIStreamChunk[] = [];
let lastClientOptions: { maxRetries?: number } | undefined;
let lastCreateBody: { stream_options?: { include_usage?: boolean } } | undefined;
let lastCreateOptions: { signal?: AbortSignal } | undefined;

mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(options?: { maxRetries?: number }) {
        lastClientOptions = options;
      }
      chat = {
        completions: {
          create: mock(
            async (
              body: { stream_options?: { include_usage?: boolean } },
              options?: { signal?: AbortSignal },
            ) => {
              lastCreateBody = body;
              lastCreateOptions = options;
              return (async function* () {
                for (const chunk of mockChunks) {
                  yield chunk;
                }
              })();
            },
          ),
        },
      };
    },
  };
});

const { mapOpenAIFinishReason, stream } = await import("@/api/openai-responses");

describe("mapOpenAIFinishReason", () => {
  it("maps length to max_output_tokens", () => {
    expect(mapOpenAIFinishReason("length")).toEqual({
      reason: "max_output_tokens",
      rawReason: "length",
    });
  });

  it("maps tool_calls and function_call to tool_call", () => {
    expect(mapOpenAIFinishReason("tool_calls")).toEqual({
      reason: "tool_call",
      rawReason: "tool_calls",
    });
    expect(mapOpenAIFinishReason("function_call")).toEqual({
      reason: "tool_call",
      rawReason: "function_call",
    });
  });

  it("maps content_filter to content_filter", () => {
    expect(mapOpenAIFinishReason("content_filter")).toEqual({
      reason: "content_filter",
      rawReason: "content_filter",
    });
  });

  it("maps error to error", () => {
    expect(mapOpenAIFinishReason("error")).toEqual({
      reason: "error",
      rawReason: "error",
    });
  });

  it("maps stop to end_turn, and null, undefined, or unknown to other", () => {
    expect(mapOpenAIFinishReason("stop")).toEqual({
      reason: "end_turn",
      rawReason: "stop",
    });
    expect(mapOpenAIFinishReason(null)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapOpenAIFinishReason(undefined)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapOpenAIFinishReason("custom_reason")).toEqual({
      reason: "other",
      rawReason: "custom_reason",
    });
  });
});

describe("OpenAI stream finishReason handling", () => {
  const model: Model = { id: "gpt-4o", name: "GPT-4o", provider: "openai" };
  const context: Context = { messages: [{ role: "user", content: "Hello" }] };

  it("maps finish_reason length to max_output_tokens on turn_end event and message", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Truncated" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "max_output_tokens",
      rawReason: "length",
    });
    expect(turnEndEvent.message.content).toEqual([{ type: "text", text: "Truncated" }]);
  });

  it("maps finish_reason tool_calls to tool_call on turn_end event and message", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Calling tool" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "tool_call",
      rawReason: "tool_calls",
    });
  });

  it("maps finish_reason content_filter to content_filter on turn_end event and message", async () => {
    mockChunks = [{ choices: [{ delta: {}, finish_reason: "content_filter" }] }];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "content_filter",
      rawReason: "content_filter",
    });
  });

  it("maps finish_reason stop to end_turn on turn_end event and message", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Done" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "end_turn",
      rawReason: "stop",
    });
    expect(turnEndEvent.message.content).toEqual([{ type: "text", text: "Done" }]);
  });

  it("captures usage from stream chunk on turn_delta and turn_end", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("defaults finishReason to other with unknown when stream has no finish_reason", async () => {
    mockChunks = [{ choices: [{ delta: { content: "Incomplete" }, finish_reason: null }] }];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
  });

  it("passes maxRetries to client and stream_options and signal to create", async () => {
    const controller = new AbortController();
    mockChunks = [{ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }];
    await collectTurnEndEvent(
      stream(model, context, {
        apiKey: "test-key",
        maxRetries: 3,
        signal: controller.signal,
      }),
    );
    expect(lastClientOptions?.maxRetries).toBe(3);
    expect(lastCreateBody?.stream_options).toEqual({ include_usage: true });
    expect(lastCreateOptions?.signal).toBe(controller.signal);
  });
});
