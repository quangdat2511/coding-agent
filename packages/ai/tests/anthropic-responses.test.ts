import { describe, expect, it, mock } from "bun:test";
import { collectTurnEndEvent } from "@tests/test-utils";
import type { Context, Model } from "@/types";

type AnthropicStreamChunk =
  | {
      type: "content_block_delta";
      delta: { type: "text_delta"; text: string };
    }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null; stop_sequence: string | null };
    }
  | {
      type: "message_stop";
    };

let mockEvents: AnthropicStreamChunk[] = [];

mock.module("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: mock(async () => {
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

  it("maps null, undefined, or unknown to end_turn or other", () => {
    expect(mapAnthropicFinishReason(null)).toEqual({
      reason: "end_turn",
      rawReason: "unknown",
    });
    expect(mapAnthropicFinishReason(undefined)).toEqual({
      reason: "end_turn",
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
      { type: "content_block_delta", delta: { type: "text_delta", text: "Tokens exceeded" } },
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
      { type: "content_block_delta", delta: { type: "text_delta", text: "Using tool" } },
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
      { type: "content_block_delta", delta: { type: "text_delta", text: "Refusal" } },
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
      { type: "content_block_delta", delta: { type: "text_delta", text: "Done" } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "end_turn",
      rawReason: "end_turn",
    });
  });
});
