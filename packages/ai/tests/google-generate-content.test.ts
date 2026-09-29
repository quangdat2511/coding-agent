import { describe, expect, it } from "bun:test";
import { buildRequestBody, mapGoogleFinishReason, stream } from "@/api/google-generate-content";
import type { Context, Model } from "@/types";

const TEST_MODEL: Model = {
  id: "gemini-2.0-flash-lite",
  name: "Gemini 2.0 Flash Lite",
  provider: "google",
};

describe("mapGoogleFinishReason", () => {
  it("maps STOP to end_turn", () => {
    expect(mapGoogleFinishReason("STOP")).toEqual({
      reason: "end_turn",
      rawReason: "STOP",
    });
  });

  it("maps MAX_TOKENS to max_output_tokens", () => {
    expect(mapGoogleFinishReason("MAX_TOKENS")).toEqual({
      reason: "max_output_tokens",
      rawReason: "MAX_TOKENS",
    });
  });

  it("maps safety-related reasons to content_filter", () => {
    for (const r of [
      "SAFETY",
      "RECITATION",
      "LANGUAGE",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
    ]) {
      expect(mapGoogleFinishReason(r)).toEqual({
        reason: "content_filter",
        rawReason: r,
      });
    }
  });

  it("maps malformed function call to error", () => {
    expect(mapGoogleFinishReason("MALFORMED_FUNCTION_CALL")).toEqual({
      reason: "error",
      rawReason: "MALFORMED_FUNCTION_CALL",
    });
  });

  it("maps null, undefined, and unrecognized reasons to other", () => {
    expect(mapGoogleFinishReason(null)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapGoogleFinishReason(undefined)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapGoogleFinishReason("CUSTOM_REASON")).toEqual({
      reason: "other",
      rawReason: "CUSTOM_REASON",
    });
  });
});

describe("buildRequestBody", () => {
  it("maps systemPrompt to system_instruction", () => {
    const context: Context = {
      systemPrompt: "You are a helpful coding assistant.",
      messages: [],
    };
    const body = buildRequestBody(context);
    expect(body.system_instruction).toEqual({
      parts: [{ text: "You are a helpful coding assistant." }],
    });
  });

  it("maps user and assistant messages with text and tool calls", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "Check weather in Tokyo" },
        {
          role: "assistant",
          model: "gemini-2.0-flash-lite",
          finishReason: { reason: "tool_call", rawReason: "STOP" },
          content: [
            { type: "text", text: "Looking up weather..." },
            {
              type: "tool_call",
              toolCallId: "call_1",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_1",
              content: '{"temp": 20}',
              isError: false,
            },
          ],
        },
      ],
    };

    const body = buildRequestBody(context);
    expect(body.contents).toHaveLength(3);

    // User turn 1
    expect(body.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "Check weather in Tokyo" }],
    });

    // Assistant turn (role: model)
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Looking up weather..." },
        {
          functionCall: {
            name: "get_weather",
            args: { city: "Tokyo" },
          },
        },
      ],
    });

    // User turn 2 with tool result
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [{ text: '{"temp": 20}' }],
    });
  });

  it("handles malformed JSON arguments in assistant tool_call gracefully", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          model: "gemini-2.0-flash-lite",
          finishReason: { reason: "tool_call", rawReason: "STOP" },
          content: [
            {
              type: "tool_call",
              toolCallId: "call_broken",
              name: "bad_tool",
              arguments: "{not valid json",
            },
          ],
        },
      ],
    };

    const body = buildRequestBody(context);
    expect(body.contents[0]?.parts[0]?.functionCall?.args).toEqual({});
  });

  it("maps tools declarations to function_declarations", () => {
    const context: Context = {
      messages: [],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };

    const body = buildRequestBody(context);
    expect(body.tools).toEqual([
      {
        function_declarations: [
          {
            name: "get_weather",
            description: "Get the current weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    ]);
  });
});

describe("stream finishReason and usage normalization", () => {
  it("emits error event and rejects result() when API key is missing", async () => {
    const context: Context = { messages: [] };
    const ms = stream(TEST_MODEL, context);

    const events: unknown[] = [];
    for await (const event of ms) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "error",
        error: { message: "API key is required" },
      },
    ]);

    expect(ms.result()).rejects.toThrow("API key is required");
  });

  it("normalizes finishReason to tool_call when tool calls are present in the response", async () => {
    const { loadFixture, sseResponse, withFixtureFetch } = await import(
      "@tests/fixtures/fixture-fetch"
    );
    const fixture = sseResponse(loadFixture("google/tool-call.txt"));

    await withFixtureFetch(fixture, async () => {
      const ms = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
      const msg = await ms.result();

      // Under ADR 0004 §2, reason must be normalized to "tool_call"
      // while rawReason preserves provider's "STOP"
      expect(msg.finishReason).toEqual({
        reason: "tool_call",
        rawReason: "STOP",
      });
      expect(msg.content.some((b) => b.type === "tool_call")).toBe(true);
    });
  });
});
