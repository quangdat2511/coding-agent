import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { collectTurnEndEvent } from "@tests/test-utils";
import { Type } from "typebox";
import {
  buildParams,
  buildTools,
  mapAnthropicFinishReason,
  stream,
} from "@/api/anthropic-responses";
import type { Context, Model, ToolDeclaration } from "@/types";

type AnthropicStreamChunk =
  | {
      type: "message_start";
      message: {
        usage: {
          input_tokens: number;
          output_tokens?: number;
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        };
      };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block: {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      };
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
      usage?: {
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
    }
  | {
      type: "message_stop";
    };

let mockEvents: AnthropicStreamChunk[] = [];
let mockCreateError: Error | null = null;
let lastClientOptions: { maxRetries?: number } | undefined;
let lastCreateOptions: { signal?: AbortSignal } | undefined;
let lastCreateBody: unknown | undefined;

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

describe("buildTools", () => {
  it("returns undefined when tools is undefined or empty", () => {
    expect(buildTools(undefined)).toBeUndefined();
    expect(buildTools([])).toBeUndefined();
  });

  it("maps ToolDeclaration to Anthropic tool schema", () => {
    const tools: ToolDeclaration[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: Type.Object({
          city: Type.String({ description: "City name" }),
        }),
      },
    ];

    const result = buildTools(tools);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.name).toBe("get_weather");
    expect(result?.[0]?.description).toBe("Get weather for a city");
    expect(result?.[0]?.input_schema).toBeDefined();
  });
});

describe("buildParams", () => {
  it("maps user string message to Anthropic message param", () => {
    const context: Context = {
      messages: [{ role: "user", content: "Hello Anthropic" }],
    };
    const params = buildParams(context);
    expect(params).toEqual([{ role: "user", content: "Hello Anthropic" }]);
  });

  it("maps user text blocks to Anthropic text block params", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello part 1" },
            { type: "text", text: " and part 2" },
          ],
        },
      ],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Hello part 1" },
          { type: "text", text: " and part 2" },
        ],
      },
    ]);
  });

  it("throws when user message contains tool_result (deferred to CDA-43)", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "check result" },
            { type: "tool_result", toolCallId: "call_1", content: "success", isError: false },
          ],
        },
      ],
    };
    expect(() => buildParams(context)).toThrow(
      "tool_result history is not supported by the Anthropic adapter yet (CDA-43)",
    );
  });

  it("maps assistant message containing text and tool_call", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the weather." },
            {
              type: "tool_call",
              toolCallId: "call_weather_1",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ],
          model: "claude-haiku-4-5",
          finishReason: { reason: "tool_call", rawReason: "tool_use" },
        },
      ],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the weather." },
          {
            type: "tool_use",
            id: "call_weather_1",
            name: "get_weather",
            input: { city: "Tokyo" },
          },
        ],
      },
    ]);
  });

  it("handles malformed JSON arguments in assistant tool_call gracefully", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCallId: "call_bad",
              name: "bad_tool",
              arguments: "{broken-json",
            },
          ],
          model: "claude-haiku-4-5",
          finishReason: { reason: "tool_call", rawReason: "tool_use" },
        },
      ],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_bad",
            name: "bad_tool",
            input: {},
          },
        ],
      },
    ]);
  });
});

describe("Anthropic stream finishReason handling", () => {
  let messagesCreateSpy: { mockRestore: () => void };

  beforeAll(() => {
    messagesCreateSpy = (
      spyOn(Anthropic.Messages.prototype, "create") as unknown as {
        mockImplementation: (
          fn: (
            this: { _client: { maxRetries?: number } },
            body: unknown,
            options?: { signal?: AbortSignal },
          ) => unknown,
        ) => { mockRestore: () => void };
      }
    ).mockImplementation(async function (
      this: { _client: { maxRetries?: number } },
      body: unknown,
      options?: { signal?: AbortSignal },
    ) {
      if (mockCreateError) {
        throw mockCreateError;
      }
      lastClientOptions = { maxRetries: this._client.maxRetries };
      lastCreateOptions = options;
      lastCreateBody = body;
      return (async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      })();
    });
  });

  afterAll(() => {
    messagesCreateSpy?.mockRestore();
  });

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
      raw: {
        input_tokens: 42,
        output_tokens: 18,
      },
    });
  });

  it("captures cachedInputTokens from cache_read_input_tokens and preserves raw usage", async () => {
    mockEvents = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 20,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Cached prompt response" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: "message_stop" },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.usage?.inputTokens).toBe(100);
    expect(turnEndEvent.message.usage?.outputTokens).toBe(15);
    expect(turnEndEvent.message.usage?.cachedInputTokens).toBe(40);
    expect(turnEndEvent.message.usage?.raw?.cache_creation_input_tokens).toBe(20);
  });

  it("handles multi-block responses — tool_use block emits start/stop and populates turn_end content", async () => {
    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Part 1" } },
      { type: "content_block_stop", index: 0 },
      // tool_use blocks now produce start/stop events and a ToolCallBlock on turn_end
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_01", name: "my_tool", input: {} },
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
    // Both text and tool_use blocks now emit start/stop
    expect(startEvents.length).toBe(2);
    expect(stopEvents.length).toBe(2);
    const turnEnd = events.find((e) => e.type === "turn_end");
    if (turnEnd?.type === "turn_end") {
      // turn_end carries both the text block and the (empty-args) tool call
      const textBlocks = turnEnd.message.content.filter((b) => b.type === "text");
      const toolCallBlocks = turnEnd.message.content.filter((b) => b.type === "tool_call");
      expect(textBlocks.length).toBe(1);
      expect(toolCallBlocks.length).toBe(1);
      expect(toolCallBlocks[0]?.type === "tool_call" && toolCallBlocks[0].name).toBe("my_tool");
    }
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
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_pre", name: "pre_tool", input: {} },
      },
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
    // Both tool_use and text blocks emit start/stop
    expect(startEvents.length).toBe(2);
    expect(stopEvents.length).toBe(2);
    const turnEnd = events.find((e) => e.type === "turn_end");
    if (turnEnd?.type === "turn_end") {
      const textBlocks = turnEnd.message.content.filter((b) => b.type === "text");
      const toolCallBlocks = turnEnd.message.content.filter((b) => b.type === "tool_call");
      expect(textBlocks).toEqual([{ type: "text", text: "Text after tool" }]);
      expect(toolCallBlocks.length).toBe(1);
    }
  });

  it("emits error event and rejects result() when context contains tool_result (CDA-43)", async () => {
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
        "tool_result history is not supported by the Anthropic adapter yet (CDA-43)",
      );
    }
    await expect(streamObj.result()).rejects.toThrow(
      "tool_result history is not supported by the Anthropic adapter yet (CDA-43)",
    );
  });

  it("passes tools to client.messages.create when context.tools is provided", async () => {
    const contextWithTools: Context = {
      messages: [{ role: "user", content: "Hello with tools" }],
      tools: [
        {
          name: "calculate",
          description: "Perform math calculation",
          parameters: Type.Object({
            expression: Type.String(),
          }),
        },
      ],
    };

    mockEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Result" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    await collectTurnEndEvent(
      stream(model, contextWithTools, {
        apiKey: "test-key",
      }),
    );

    const body = lastCreateBody as { tools?: Array<{ name: string; description: string }> };
    expect(body.tools).toBeDefined();
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.name).toBe("calculate");
    expect(body.tools?.[0]?.description).toBe("Perform math calculation");
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
