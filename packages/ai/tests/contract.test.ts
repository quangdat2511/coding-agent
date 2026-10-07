import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import type {
  AssistantContentBlock,
  AssistantMessage,
  ContentBlock,
  Context,
  FinishReason,
  Model,
  ModelCapabilities,
  ModelStream,
  ModelStreamEvent,
  StreamOptions,
  TextBlock,
  ToolCallBlock,
  ToolDeclaration,
  ToolResultBlock,
  UserMessage,
} from "#src/index";
import { flattenMessageContent } from "#src/utils/messages";

describe("ADR 0004 Model Interaction Contract", () => {
  it("supports ToolDeclaration with TypeBox 1.x schema", () => {
    const WeatherParams = Type.Object({
      city: Type.String({ description: "City name" }),
      units: Type.Optional(Type.Union([Type.Literal("metric"), Type.Literal("imperial")])),
    });

    const tool: ToolDeclaration<typeof WeatherParams> = {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: WeatherParams,
    };

    expect(tool.name).toBe("get_weather");
    expect(tool.description).toBe("Get current weather for a city");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties.city.type).toBe("string");
  });

  it("supports ContentBlock discriminated union variants", () => {
    const textBlock: ContentBlock = { type: "text", text: "hello" };
    const toolCall: ContentBlock = {
      type: "tool_call",
      toolCallId: "id-1",
      name: "tool",
      arguments: "{}",
    };
    const toolResult: ContentBlock = {
      type: "tool_result",
      toolCallId: "id-1",
      content: "output",
      isError: false,
    };
    expect(textBlock.type).toBe("text");
    expect(toolCall.type).toBe("tool_call");
    expect(toolResult.type).toBe("tool_result");
  });

  it("supports Context with tools and multi-block user message", () => {
    const textBlock: TextBlock = { type: "text", text: "Explain this result" };
    const toolResultBlock: ToolResultBlock = {
      type: "tool_result",
      toolCallId: "call-123",
      content: "Temp: 22C",
      isError: false,
    };

    const userMsg: UserMessage = {
      role: "user",
      content: [textBlock, toolResultBlock],
    };

    const context: Context = {
      systemPrompt: "You are a helpful assistant",
      messages: [userMsg],
      tools: [
        {
          name: "dummy_tool",
          description: "A dummy tool",
          parameters: Type.Object({}),
        },
      ],
    };

    expect(context.tools?.length).toBe(1);
    expect(context.messages.length).toBe(1);
    expect(Array.isArray(userMsg.content)).toBe(true);
    if (Array.isArray(userMsg.content)) {
      expect(userMsg.content[0]?.type).toBe("text");
      expect(userMsg.content[1]?.type).toBe("tool_result");
    }
  });

  it("supports AssistantMessage with TextBlock, ToolCallBlock, and FinishReason", () => {
    const toolCall: ToolCallBlock = {
      type: "tool_call",
      toolCallId: "call_abc",
      name: "get_weather",
      arguments: '{"city":"Tokyo"}',
    };

    const textBlock: TextBlock = {
      type: "text",
      text: "Let me check the weather.",
    };

    const finishReason: FinishReason = {
      reason: "tool_call",
      rawReason: "tool_use",
    };

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: [textBlock, toolCall],
      model: "claude-sonnet-4-5",
      finishReason,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    };

    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content.length).toBe(2);
    expect(assistantMsg.finishReason.reason).toBe("tool_call");
    expect(assistantMsg.finishReason.rawReason).toBe("tool_use");
    expect(assistantMsg.usage?.inputTokens).toBe(100);
  });

  it("supports ModelCapabilities on Model", () => {
    const capabilities: ModelCapabilities = {
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "streamed",
      usageTiming: "final",
      serverSideTools: false,
    };

    const model: Model = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      capabilities,
    };

    expect(model.capabilities?.parallelToolCallControl).toBe(true);
    expect(model.capabilities?.cancellation).toBe("client_abort_only");
    expect(model.capabilities?.toolArgumentDelivery).toBe("streamed");
    expect(model.capabilities?.usageTiming).toBe("final");
    expect(model.capabilities?.serverSideTools).toBe(false);
  });

  it("supports StreamOptions with maxRetries and signal", () => {
    const controller = new AbortController();
    const options: StreamOptions = {
      maxRetries: 0,
      signal: controller.signal,
      maxTokens: 1024,
      temperature: 0.7,
    };

    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBe(controller.signal);
  });

  it("supports structural ModelStream consumer pattern", async () => {
    const events: ModelStreamEvent[] = [
      { type: "stream_start" },
      {
        type: "content_block_start",
        index: 0,
        block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "turn_delta",
        finishReason: { reason: "end_turn", rawReason: "stop" },
      },
      {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          model: "test-model",
          finishReason: { reason: "end_turn", rawReason: "stop" },
        },
      },
    ];

    const fakeStream: ModelStream = {
      async *[Symbol.asyncIterator]() {
        for (const ev of events) {
          yield ev;
        }
      },
      async result() {
        return {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          model: "test-model",
          finishReason: { reason: "end_turn", rawReason: "stop" },
        };
      },
    };

    const consumed: string[] = [];
    for await (const event of fakeStream) {
      consumed.push(event.type);
    }

    expect(consumed).toEqual([
      "stream_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "turn_delta",
      "turn_end",
    ]);

    const result = await fakeStream.result();
    expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(result.finishReason.reason).toBe("end_turn");
  });

  it("supports AssistantContentBlock variants for model stream events", () => {
    const textBlock: AssistantContentBlock = { type: "text", text: "Hello" };
    const toolCallBlock: AssistantContentBlock = {
      type: "tool_call",
      toolCallId: "call-1",
      name: "search",
      arguments: "{}",
    };

    const event1: ModelStreamEvent = {
      type: "content_block_start",
      index: 0,
      block: textBlock,
    };
    const event2: ModelStreamEvent = {
      type: "content_block_start",
      index: 1,
      block: toolCallBlock,
    };

    expect(event1.type).toBe("content_block_start");
    expect(event2.type).toBe("content_block_start");
  });

  it("flattenMessageContent flattens text messages and throws on tool_call or tool_result blocks", () => {
    const plainUser: UserMessage = { role: "user", content: "hello world" };
    expect(flattenMessageContent(plainUser)).toBe("hello world");

    const textOnlyUser: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "part 1 " },
        { type: "text", text: "part 2" },
      ],
    };
    expect(flattenMessageContent(textOnlyUser)).toBe("part 1 part 2");

    const userWithToolResult: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_result", toolCallId: "1", content: "data", isError: false },
      ],
    };
    expect(() => flattenMessageContent(userWithToolResult)).toThrow(
      "tool_call/tool_result content is not supported by this adapter yet",
    );

    const assistantWithToolCall: AssistantMessage = {
      role: "assistant",
      content: [{ type: "tool_call", toolCallId: "1", name: "tool", arguments: "{}" }],
      model: "gpt-4o",
      finishReason: { reason: "tool_call", rawReason: "tool_calls" },
    };
    expect(() => flattenMessageContent(assistantWithToolCall)).toThrow(
      "tool_call/tool_result content is not supported by this adapter yet",
    );
  });
});
