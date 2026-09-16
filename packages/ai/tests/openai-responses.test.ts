import { describe, expect, it, mock } from "bun:test";
import { collectTurnEndEvent } from "@tests/test-utils";
import type { Context, Model } from "@/types";

type OpenAIStreamChunk = {
  choices: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
};

let mockChunks: OpenAIStreamChunk[] = [];

mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mock(async () => {
            return (async function* () {
              for (const chunk of mockChunks) {
                yield chunk;
              }
            })();
          }),
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

  it("maps stop, null, undefined, or unknown to end_turn or other", () => {
    expect(mapOpenAIFinishReason("stop")).toEqual({
      reason: "end_turn",
      rawReason: "stop",
    });
    expect(mapOpenAIFinishReason(null)).toEqual({
      reason: "end_turn",
      rawReason: "unknown",
    });
    expect(mapOpenAIFinishReason(undefined)).toEqual({
      reason: "end_turn",
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
});
