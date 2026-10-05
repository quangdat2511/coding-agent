import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import OpenAI from "openai";
import { Type } from "typebox";
import {
  buildParams,
  buildTools,
  mapOpenAIFinishReason,
  stream,
} from "../src/api/openai-responses.ts";
import type { Context, Model, ToolDeclaration } from "../src/types.ts";
import { collectTurnEndEvent } from "./test-utils.ts";

type OpenAIStreamChunk = {
  choices: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
};

let mockChunks: OpenAIStreamChunk[] = [];
let mockCreateError: Error | null = null;
let lastClientOptions: { maxRetries?: number } | undefined;
let lastCreateBody:
  | {
      model?: string;
      tools?: Array<{ type: string; function: { name: string; description?: string } }>;
      stream_options?: { include_usage?: boolean };
    }
  | undefined;
let lastCreateOptions: { signal?: AbortSignal } | undefined;

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

describe("buildTools", () => {
  it("returns undefined when tools is undefined or empty", () => {
    expect(buildTools(undefined)).toBeUndefined();
    expect(buildTools([])).toBeUndefined();
  });

  it("maps tool declarations to OpenAI function tool definitions", () => {
    const tools: ToolDeclaration[] = [
      {
        name: "get_weather",
        description: "Get the current weather",
        parameters: Type.Object({
          city: Type.String({ description: "City name" }),
        }),
      },
    ];

    const result = buildTools(tools);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result?.[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather",
        parameters: tools[0]?.parameters as Record<string, unknown>,
      },
    });
  });
});

describe("buildParams", () => {
  it("maps systemPrompt to system role message", () => {
    const context: Context = {
      systemPrompt: "You are a coding assistant.",
      messages: [{ role: "user", content: "Hello" }],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Hello" },
    ]);
  });

  it("maps user text blocks to string content", () => {
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
    expect(params).toEqual([{ role: "user", content: "Hello part 1 and part 2" }]);
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
      "tool_result history is not supported by this adapter yet (CDA-43)",
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
          model: "openai/gpt-4o-mini",
          finishReason: { reason: "tool_call", rawReason: "tool_calls" },
        },
      ],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      {
        role: "assistant",
        content: "Let me check the weather.",
        tool_calls: [
          {
            id: "call_weather_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          },
        ],
      },
    ]);
  });

  it("maps assistant message containing only tool_call with content null", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCallId: "call_weather_2",
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          ],
          model: "openai/gpt-4o-mini",
          finishReason: { reason: "tool_call", rawReason: "tool_calls" },
        },
      ],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_weather_2",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      },
    ]);
  });

  it("handles malformed JSON arguments in assistant tool_call gracefully without throwing", () => {
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
          model: "openai/gpt-4o-mini",
          finishReason: { reason: "tool_call", rawReason: "tool_calls" },
        },
      ],
    };
    const params = buildParams(context);
    expect(params).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: {
              name: "bad_tool",
              arguments: "{broken-json",
            },
          },
        ],
      },
    ]);
  });
});

describe("OpenAI stream finishReason handling", () => {
  let completionsCreateSpy: { mockRestore: () => void };

  beforeAll(() => {
    completionsCreateSpy = (
      spyOn(OpenAI.Chat.Completions.prototype, "create") as unknown as {
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
      lastCreateBody = body as { stream_options?: { include_usage?: boolean } };
      lastCreateOptions = options;
      return (async function* () {
        for (const chunk of mockChunks) {
          yield chunk;
        }
      })();
    });
  });

  afterAll(() => {
    completionsCreateSpy?.mockRestore();
  });

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
      raw: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  it("emits error event and rejects result() when stream has no finish_reason", async () => {
    mockChunks = [{ choices: [{ delta: { content: "Incomplete" }, finish_reason: null }] }];

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

  it("defaults maxRetries to 0 when omitted in StreamOptions", async () => {
    mockChunks = [{ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }];
    await collectTurnEndEvent(
      stream(model, context, {
        apiKey: "test-key",
      }),
    );
    expect(lastClientOptions?.maxRetries).toBe(0);
  });

  it("maps mid-stream error finish_reason from OpenRouter to error", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Hello, I was about to" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "error" }] },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.finishReason).toEqual({
      reason: "error",
      rawReason: "error",
    });
    expect(turnEndEvent.message.content).toEqual([{ type: "text", text: "Hello, I was about to" }]);
  });

  it("captures usage when delivered in a standalone chunk with empty choices", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 25, completion_tokens: 12 } },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.usage).toEqual({
      inputTokens: 25,
      outputTokens: 12,
      raw: { prompt_tokens: 25, completion_tokens: 12 },
    });
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
        "tool_result history is not supported by this adapter yet (CDA-43)",
      );
    }
    await expect(streamObj.result()).rejects.toThrow(
      "tool_result history is not supported by this adapter yet (CDA-43)",
    );
  });

  it("emits error event and rejects result() when create throws an error", async () => {
    mockCreateError = new Error("Connection aborted");
    try {
      const streamObj = stream(model, context, { apiKey: "test-key" });
      const events = [];
      for await (const ev of streamObj) {
        events.push(ev);
      }
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("error");
      if (events[0]?.type === "error") {
        expect(events[0].error.message).toBe("Connection aborted");
      }
      await expect(streamObj.result()).rejects.toThrow("Connection aborted");
    } finally {
      mockCreateError = null;
    }
  });

  it("streams a tool call with 0-indexed content_block_start, argument accumulation, and content_block_stop", async () => {
    mockChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"city":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"Tokyo"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }

    const startEvent = events.find((e) => e.type === "content_block_start");
    expect(startEvent).toBeDefined();
    if (startEvent?.type === "content_block_start") {
      expect(startEvent.index).toBe(0);
      expect(startEvent.block).toEqual({
        type: "tool_call",
        toolCallId: "call-1",
        name: "get_weather",
        arguments: "",
      });
    }

    const stopEvent = events.find((e) => e.type === "content_block_stop");
    expect(stopEvent).toBeDefined();
    if (stopEvent?.type === "content_block_stop") {
      expect(stopEvent.index).toBe(0);
    }

    const turnEndEvent = events.find((e) => e.type === "turn_end");
    expect(turnEndEvent).toBeDefined();
    if (turnEndEvent?.type === "turn_end") {
      expect(turnEndEvent.message.content).toEqual([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
      ]);
    }
  });

  it("preserves chronological ordering and contiguous 0-indexed indices when text is followed by tool call", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Thinking..." }, finish_reason: null }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"ts"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }

    const startEvents = events.filter((e) => e.type === "content_block_start");
    expect(startEvents.length).toBe(2);
    expect(startEvents[0]?.index).toBe(0);
    expect(startEvents[1]?.index).toBe(1);

    const stopEvents = events.filter((e) => e.type === "content_block_stop");
    expect(stopEvents.length).toBe(2);
    expect(stopEvents[0]?.index).toBe(0);
    expect(stopEvents[1]?.index).toBe(1);

    const turnEndEvent = events.find((e) => e.type === "turn_end");
    if (turnEndEvent?.type === "turn_end") {
      expect(turnEndEvent.message.content).toEqual([
        { type: "text", text: "Thinking..." },
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "search",
          arguments: '{"q":"ts"}',
        },
      ]);
    }
  });

  it("preserves chronological ordering and contiguous 0-indexed indices when tool call is followed by text", async () => {
    mockChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: { content: "Here is the weather" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }

    const startEvents = events.filter((e) => e.type === "content_block_start");
    expect(startEvents.length).toBe(2);
    expect(startEvents[0]?.index).toBe(0);
    expect(startEvents[0]?.block.type).toBe("tool_call");
    expect(startEvents[1]?.index).toBe(1);
    expect(startEvents[1]?.block.type).toBe("text");

    const stopEvents = events.filter((e) => e.type === "content_block_stop");
    expect(stopEvents.length).toBe(2);
    expect(stopEvents[0]?.index).toBe(0);
    expect(stopEvents[1]?.index).toBe(1);

    const turnEndEvent = events.find((e) => e.type === "turn_end");
    if (turnEndEvent?.type === "turn_end") {
      expect(turnEndEvent.message.content).toEqual([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
        { type: "text", text: "Here is the weather" },
      ]);
    }
  });

  it("handles parallel tool calls with sequential 0-indexed block indices", async () => {
    mockChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-a",
                  type: "function",
                  function: { name: "toolA", arguments: '{"a":1}' },
                },
                {
                  index: 1,
                  id: "call-b",
                  type: "function",
                  function: { name: "toolB", arguments: '{"b":2}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }

    const startEvents = events.filter((e) => e.type === "content_block_start");
    expect(startEvents.length).toBe(2);
    expect(startEvents[0]?.index).toBe(0);
    expect(startEvents[1]?.index).toBe(1);

    const turnEndEvent = events.find((e) => e.type === "turn_end");
    if (turnEndEvent?.type === "turn_end") {
      expect(turnEndEvent.message.content).toEqual([
        {
          type: "tool_call",
          toolCallId: "call-a",
          name: "toolA",
          arguments: '{"a":1}',
        },
        {
          type: "tool_call",
          toolCallId: "call-b",
          name: "toolB",
          arguments: '{"b":2}',
        },
      ]);
    }
  });

  it("guards against duplicate id from proxies in subsequent chunks without resetting accumulator", async () => {
    mockChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-dup",
                  type: "function",
                  function: { name: "calc", arguments: '{"step":1' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-dup", // Repeated id from proxy
                  function: { arguments: ',"step":2}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];

    const streamObj = stream(model, context, { apiKey: "test-key" });
    const events = [];
    for await (const ev of streamObj) {
      events.push(ev);
    }

    // Only one content_block_start should be emitted despite duplicate id in chunk 2
    const startEvents = events.filter((e) => e.type === "content_block_start");
    expect(startEvents.length).toBe(1);

    const turnEndEvent = events.find((e) => e.type === "turn_end");
    if (turnEndEvent?.type === "turn_end") {
      expect(turnEndEvent.message.content).toEqual([
        {
          type: "tool_call",
          toolCallId: "call-dup",
          name: "calc",
          arguments: '{"step":1,"step":2}',
        },
      ]);
    }
  });

  it("passes tools to client.chat.completions.create when context.tools is provided", async () => {
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

    mockChunks = [{ choices: [{ delta: { content: "Result" }, finish_reason: "stop" }] }];

    await collectTurnEndEvent(
      stream(model, contextWithTools, {
        apiKey: "test-key",
      }),
    );

    expect(lastCreateBody?.tools).toBeDefined();
    expect(lastCreateBody?.tools).toHaveLength(1);
    expect(lastCreateBody?.tools?.[0]?.type).toBe("function");
    expect(lastCreateBody?.tools?.[0]?.function.name).toBe("calculate");
    expect(lastCreateBody?.tools?.[0]?.function.description).toBe("Perform math calculation");
  });

  it("preserves model identifiers containing a slash end-to-end (e.g. openai/gpt-4o-mini)", async () => {
    const slashModel: Model = {
      id: "openai/gpt-4o-mini",
      name: "GPT-4o mini (OpenRouter)",
      provider: "openrouter",
    };
    mockChunks = [{ choices: [{ delta: { content: "Preserved" }, finish_reason: "stop" }] }];

    const turnEndEvent = await collectTurnEndEvent(
      stream(slashModel, context, { apiKey: "test-key" }),
    );

    expect(lastCreateBody?.model).toBe("openai/gpt-4o-mini");
    expect(turnEndEvent.message.model).toBe("openai/gpt-4o-mini");
  });

  it("captures cachedInputTokens from prompt_tokens_details and reasoningTokens from completion_tokens_details", async () => {
    mockChunks = [
      { choices: [{ delta: { content: "Cached and reasoned" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 45,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens_details: { reasoning_tokens: 15 },
        } as unknown as { prompt_tokens: number; completion_tokens: number },
      },
    ];

    const turnEndEvent = await collectTurnEndEvent(stream(model, context, { apiKey: "test-key" }));
    expect(turnEndEvent.message.usage?.inputTokens).toBe(120);
    expect(turnEndEvent.message.usage?.outputTokens).toBe(45);
    expect(turnEndEvent.message.usage?.cachedInputTokens).toBe(30);
    expect(turnEndEvent.message.usage?.reasoningTokens).toBe(15);
    expect(turnEndEvent.message.usage?.raw).toBeDefined();
  });
});
