import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessageEvent, Context, Model } from "@/types";

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

const { mapAnthropicStopReason, stream } = await import("@/api/anthropic-responses");

describe("mapAnthropicStopReason", () => {
  it("maps max_tokens to length", () => {
    expect(mapAnthropicStopReason("max_tokens")).toBe("length");
  });

  it("maps tool_use to toolUse", () => {
    expect(mapAnthropicStopReason("tool_use")).toBe("toolUse");
  });

  it("maps refusal to error", () => {
    expect(mapAnthropicStopReason("refusal")).toBe("error");
  });

  it("maps end_turn and stop_sequence to stop", () => {
    expect(mapAnthropicStopReason("end_turn")).toBe("stop");
    expect(mapAnthropicStopReason("stop_sequence")).toBe("stop");
  });

  it("maps null, undefined, or unknown to stop", () => {
    expect(mapAnthropicStopReason(null)).toBe("stop");
    expect(mapAnthropicStopReason(undefined)).toBe("stop");
    expect(mapAnthropicStopReason("other_reason")).toBe("stop");
  });
});

async function collectDoneEvent(
  eventStream: AsyncIterable<AssistantMessageEvent>,
): Promise<Extract<AssistantMessageEvent, { type: "done" }>> {
  for await (const event of eventStream) {
    if (event.type === "done") {
      return event;
    }
  }
  throw new Error("Stream completed without a 'done' event");
}

describe("Anthropic stream stopReason handling", () => {
  const model: Model = {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
  };
  const context: Context = { messages: [{ role: "user", content: "Hello" }] };

  it("maps message_delta stop_reason max_tokens to length on done event and message", async () => {
    mockEvents = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Tokens exceeded" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("length");
    expect(doneEvent.message.stopReason).toBe("length");
    expect(doneEvent.message.content).toEqual([{ type: "text", text: "Tokens exceeded" }]);
  });

  it("maps message_delta stop_reason tool_use to toolUse on done event and message", async () => {
    mockEvents = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Using tool" } },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
  });

  it("maps message_delta stop_reason refusal to error on done event and message", async () => {
    mockEvents = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Refusal" } },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("error");
    expect(doneEvent.message.stopReason).toBe("error");
  });

  it("maps message_delta stop_reason end_turn to stop on done event and message", async () => {
    mockEvents = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Done" } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message.stopReason).toBe("stop");
  });
});
