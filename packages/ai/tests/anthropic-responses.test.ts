import { describe, expect, it, mock } from "bun:test";
import { collectTurnEndEvent } from "@tests/test-utils";
import type { Context, Model } from "@/types";

type AnthropicStreamChunk =
  | {
      type: "message_start";
      message: { usage: { input_tokens: number; output_tokens?: number } };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block: { type: string; text?: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: { type: "text_delta"; text: string };
    }
  | {
      type: "content_block_stop";
      index: number;
    }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null; stop_sequence: string | null };
      usage?: { output_tokens: number };
    }
  | {
      type: "message_stop";
    };

let mockEvents: AnthropicStreamChunk[] = [];
let mockCreateError: Error | null = null;
let lastClientOptions: { maxRetries?: number } | undefined;
let lastCreateOptions: { signal?: AbortSignal } | undefined;

mock.module("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      constructor(options?: { maxRetries?: number }) {
        lastClientOptions = options;
      }
      messages = {
        create: mock(async (_body: unknown, options?: { signal?: AbortSignal }) => {
          if (mockCreateError) {
            throw mockCreateError;
          }
          lastCreateOptions = options;
          return (async function* () {
            for (const event of mockEvents) {
              yield event;
            }
          })();
        }),
      };
    },
  };
});

const { mapAnthropicFinishReason, stream } = await import("@/api/anthropic-responses");

describe("mapAnthropicFinishReason", () => {
  it("maps max_tokens to max_output_tokens", () => {
    expect(mapAnthropicFinishReason("max_tokens")).toEqual({
      reason: "max_output_tokens",
      rawReason: "max_tokens",
    });
  });

  it("maps tool_use to tool_call", () => {
    expect(mapAnthropicFinishReason("tool_use")).toEqual({
      reason: "tool_call",
      rawReason: "tool_use",
    });
  });

  it("maps refusal to content_filter", () => {
    expect(mapAnthropicFinishReason("refusal")).toEqual({
      reason: "content_filter",
      rawReason: "refusal",
    });
  });

  it("maps end_turn to end_turn", () => {
    expect(mapAnthropicFinishReason("end_turn")).toEqual({
      reason: "end_turn",
      rawReason: "end_turn",
    });
  });

  it("maps stop_sequence to stop_sequence", () => {
    expect(mapAnthropicFinishReason("stop_sequence")).toEqual({
      reason: "stop_sequence",
      rawReason: "stop_sequence",
    });
  });

  it("maps null, undefined, or unknown to other", () => {
    expect(mapAnthropicFinishReason(null)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapAnthropicFinishReason(undefined)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapAnthropicFinishReason("other_reason")).toEqual({
      reason: "other",
      rawReason: "other_reason",
    });
  });
});

describe("Anthropic stream finishReason handling", () => {
  const model: Model = {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
  };
  const context: Context = { messages: [{ role: "user", content: "Hello" }] };

  it("maps message_delta stop_reason max_tokens to max_output_tokens on turn_end event and message", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Tokens exceeded" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "max_output_tokens",
      rawReason: "max_tokens",
    });
    expect(turnEndEvent.message.content).toEqual([{ type: "text", text: "Tokens exceeded" }]);
  });

  it("maps message_delta stop_reason tool_use to tool_call on turn_end event and message", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Using tool" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "tool_call",
      rawReason: "tool_use",
    });
  });

  it("maps message_delta stop_reason refusal to content_filter on turn_end event and message", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Refusal" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "content_filter",
      rawReason: "refusal",
    });
  });

  it("maps message_delta stop_reason end_turn to end_turn on turn_end event and message", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "end_turn",
      rawReason: "end_turn",
    });
  });

  it("captures input_tokens from message_start and output_tokens from message_delta", async () => {
    mockEvents = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 42, output_tokens: 0 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello with usage" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 18 },
      },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.usage).toEqual({
      inputTokens: 42,
      outputTokens: 18,
    });
  });

  it("handles multi-block responses without emitting stops for unstarted blocks", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Part 1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }
    const startEvents = events.filter((e) => e.type === "content_block_start");
    const stopEvents = events.filter((e) => e.type === "content_block_stop");
    expect(startEvents.length).toBe(1);
    expect(startEvents[0]?.index).toBe(0);
    expect(stopEvents.length).toBe(1);
    expect(stopEvents[0]?.index).toBe(0);
  });

  it("emits error event and rejects result() when stream has no finish_reason", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toBe("Stream ended without a finish reason");
    }
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    await expect(streamObj.result()).rejects.toThrow("Stream ended without a finish reason");
  });

  it("passes maxRetries to client and signal to create", async () => {
    const controller = new AbortController();
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];
    await collectTurnEndEvent(
      stream(model, context, {
        apiKey: "test-key",
        maxRetries: 2,
        signal: controller.signal,
      }),
    );
    expect(lastClientOptions?.maxRetries).toBe(2);
    expect(lastCreateOptions?.signal).toBe(controller.signal);
  });

  it("defaults maxRetries to 0 when omitted in StreamOptions", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];
    await collectTurnEndEvent(
      stream(model, context, {
        apiKey: "test-key",
      }),
    );
    expect(lastClientOptions?.maxRetries).toBe(0);
  });

  it("handles multi-block response when tool_use block precedes text block", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Text after tool" },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }
    const startEvents = events.filter((e) => e.type === "content_block_start");
    const stopEvents = events.filter((e) => e.type === "content_block_stop");
    expect(startEvents.length).toBe(1);
    expect(startEvents[0]?.index).toBe(1);
    expect(stopEvents.length).toBe(1);
    expect(stopEvents[0]?.index).toBe(1);
    const turnEnd = events.find((e) => e.type === "turn_end");
    if (turnEnd?.type === "turn_end") {
      expect(turnEnd.message.content).toEqual([{ type: "text", text: "Text after tool" }]);
    }
  });

  it("emits error event and rejects result() when context contains tool_call/tool_result", async () => {
    const contextWithToolResult: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_result", toolCallId: "call-1", content: "ok", isError: false },
          ],
        },
      ],
    };

    const streamObj = stream(model, contextWithToolResult, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.message).toContain(
        "tool_call/tool_result content is not supported by this adapter yet",
      );
    }
    await expect(streamObj.result()).rejects.toThrow(
      "tool_call/tool_result content is not supported by this adapter yet",
    );
  });

  it("emits error event and rejects result() when messages.create throws an error", async () => {
    mockCreateError = new Error("API rate limit exceeded");
    try {
      const streamObj = stream(model, context, { apiKey: "test-key" });
      const events = [];
      for await (const ev of streamObj) {
        events.push(ev);
      }
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("error");
      if (events[0]?.type === "error") {
        expect(events[0].error.message).toBe("API rate limit exceeded");
      }
      await expect(streamObj.result()).rejects.toThrow("API rate limit exceeded");
    } finally {
      mockCreateError = null;
    }
  });
});
