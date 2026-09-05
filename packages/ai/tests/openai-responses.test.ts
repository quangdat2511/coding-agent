import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessageEvent, Context, Model } from "@/types";

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
  it("maps length to length", () => {
    expect(mapOpenAIFinishReason("length")).toBe("length");
  });

  it("maps tool_calls and function_call to toolUse", () => {
    expect(mapOpenAIFinishReason("tool_calls")).toBe("toolUse");
    expect(mapOpenAIFinishReason("function_call")).toBe("toolUse");
  });

  it("maps content_filter to error", () => {
    expect(mapOpenAIFinishReason("content_filter")).toBe("error");
  });

  it("maps stop, null, undefined, or unknown to stop", () => {
    expect(mapOpenAIFinishReason("stop")).toBe("stop");
    expect(mapOpenAIFinishReason(null)).toBe("stop");
    expect(mapOpenAIFinishReason(undefined)).toBe("stop");
    expect(mapOpenAIFinishReason("unknown")).toBe("stop");
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

describe("OpenAI stream finishReason handling", () => {
  const model: Model = { id: "gpt-4o", name: "GPT-4o", provider: "openai" };
  const context: Context = { messages: [{ role: "user", content: "Hello" }] };

  it("maps finish_reason length to length on done event and message", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Truncated" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("length");
    expect(doneEvent.message.stopReason).toBe("length");
    expect(doneEvent.message.content).toEqual([{ type: "text", text: "Truncated" }]);
  });

  it("maps finish_reason tool_calls to toolUse on done event and message", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Calling tool" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
  });

  it("maps finish_reason content_filter to error on done event and message", async () => {
    mockChunks = [{ choices: [{ delta: {}, finish_reason: "content_filter" }] }];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("error");
    expect(doneEvent.message.stopReason).toBe("error");
  });

  it("maps finish_reason stop to stop on done event and message", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Done" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const doneEvent = await collectDoneEvent(stream(model, context, { apiKey: "test-key" }));
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message.stopReason).toBe("stop");
    expect(doneEvent.message.content).toEqual([{ type: "text", text: "Done" }]);
  });
});
