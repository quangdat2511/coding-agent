import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  CustomModelConfigSchema,
  CustomProviderConfigSchema,
  CustomProviderValidationError,
  createCustomProvider,
  LOCAL_RUNNER_NO_AUTH_KEY,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  ProviderDirectory,
} from "../src/index.ts";
import type { Context, Model, ToolDeclaration } from "../src/types.ts";
import { collectTurnEndEvent } from "./test-utils.ts";

// --- OpenAI Mocks ---
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
};

let mockOpenAIChunks: OpenAIStreamChunk[] = [];
let lastOpenAIClientOptions: { baseURL?: string } | undefined;
let openAISpy: { mockRestore: () => void } | undefined;

// --- Anthropic Mocks ---
type AnthropicStreamEvent = Record<string, unknown>;
let mockAnthropicEvents: AnthropicStreamEvent[] = [];
let lastAnthropicClientOptions:
  | { baseURL?: string; defaultHeaders?: Record<string, string> }
  | undefined;
let anthropicSpy: { mockRestore: () => void } | undefined;

beforeAll(() => {
  openAISpy = (
    spyOn(OpenAI.Chat.Completions.prototype, "create") as unknown as {
      mockImplementation: (
        fn: (this: { _client: { baseURL?: string } }, body: unknown, options?: unknown) => unknown,
      ) => { mockRestore: () => void };
    }
  ).mockImplementation(async function (this: { _client: { baseURL?: string } }) {
    lastOpenAIClientOptions = { baseURL: this._client.baseURL };
    return (async function* () {
      for (const chunk of mockOpenAIChunks) {
        yield chunk;
      }
    })();
  });

  anthropicSpy = (
    spyOn(Anthropic.Messages.prototype, "create") as unknown as {
      mockImplementation: (
        fn: (
          this: {
            _client: {
              baseURL?: string;
              defaultHeaders?: Record<string, string>;
            };
          },
          body: unknown,
          options?: unknown,
        ) => unknown,
      ) => { mockRestore: () => void };
    }
  ).mockImplementation(async function (this: {
    _client: {
      baseURL?: string;
      _options?: { defaultHeaders?: Record<string, string> };
    };
  }) {
    lastAnthropicClientOptions = {
      baseURL: this._client.baseURL,
      defaultHeaders: this._client._options?.defaultHeaders,
    };
    return (async function* () {
      for (const event of mockAnthropicEvents) {
        yield event;
      }
    })();
  });
});

afterAll(() => {
  openAISpy?.mockRestore();
  anthropicSpy?.mockRestore();
});

describe("Custom Provider Schema & Validation", () => {
  it("exports schemas and validator error class", () => {
    expect(CustomModelConfigSchema).toBeDefined();
    expect(CustomProviderConfigSchema).toBeDefined();
    expect(CustomProviderValidationError).toBeDefined();
  });

  it("throws CustomProviderValidationError on invalid configuration", () => {
    // Missing id
    expect(() =>
      createCustomProvider({
        id: "",
        variant: "chat_completions",
        models: [{ id: "m1" }],
      }),
    ).toThrow(CustomProviderValidationError);

    // Invalid variant
    expect(() =>
      createCustomProvider({
        id: "test",
        // @ts-expect-error test invalid variant runtime validation
        variant: "unsupported_variant",
        models: [{ id: "m1" }],
      }),
    ).toThrow(CustomProviderValidationError);

    // Empty models array
    expect(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        models: [],
      }),
    ).toThrow(CustomProviderValidationError);

    expect(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        models: [{ id: "" }],
      }),
    ).toThrow(CustomProviderValidationError);

    expect(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        models: [
          {
            id: "m1",
            capabilities: {
              // @ts-expect-error test unknown capability property
              unknownField: true,
            },
          },
        ],
      }),
    ).toThrow(CustomProviderValidationError);
  });

  it("instantiates provider with valid minimal config", () => {
    const provider = createCustomProvider({
      id: "minimal-provider",
      variant: "chat_completions",
      models: [{ id: "m1" }],
    });

    expect(provider.id).toBe("minimal-provider");
    expect(provider.name).toBe("minimal-provider");
    expect(provider.variant).toBe("chat_completions");
    expect(provider.getModels()).toHaveLength(1);
    expect(provider.getModels()[0]?.id).toBe("m1");
    expect(provider.getModels()[0]?.name).toBe("m1");
    expect(provider.getModels()[0]?.provider).toBe("minimal-provider");
  });

  it("normalizes baseUrl by stripping trailing slashes", () => {
    const provider = createCustomProvider({
      id: "ollama",
      variant: "chat_completions",
      baseUrl: "http://localhost:11434/v1///",
      models: [{ id: "llama3" }],
    });

    expect(provider.baseUrl).toBe("http://localhost:11434/v1");
  });
});

describe("Credential Resolution", () => {
  it("resolves explicit apiKey directly and trims whitespace", async () => {
    const provider = createCustomProvider({
      id: "custom-auth",
      variant: "chat_completions",
      apiKey: "  secret-key-123\r\n  ",
      models: [{ id: "m1" }],
    });

    const resolved = await provider.auth.apiKey?.resolve();
    expect(resolved).toBe("secret-key-123");
  });

  it("resolves apiKeyEnv from environment variables and trims whitespace", async () => {
    const envKey = "TEST_CUSTOM_API_KEY_ENV";
    process.env[envKey] = "   env-secret-456\r\n ";

    try {
      const provider = createCustomProvider({
        id: "custom-env",
        variant: "chat_completions",
        apiKeyEnv: envKey,
        models: [{ id: "m1" }],
      });

      const resolved = await provider.auth.apiKey?.resolve();
      expect(resolved).toBe("env-secret-456");
    } finally {
      delete process.env[envKey];
    }
  });

  it("resolves to undefined when apiKeyEnv is specified but absent from environment", async () => {
    const missingEnv = "NON_EXISTENT_AI_KEY_789";
    delete process.env[missingEnv];

    const provider = createCustomProvider({
      id: "custom-missing-env",
      variant: "chat_completions",
      apiKeyEnv: missingEnv,
      models: [{ id: "m1" }],
    });

    const resolved = await provider.auth.apiKey?.resolve();
    expect(resolved).toBeUndefined();
  });

  it("prioritizes explicit apiKey over apiKeyEnv", async () => {
    const envKey = "TEST_PRIORITY_KEY_ENV";
    process.env[envKey] = "from-env";

    try {
      const provider = createCustomProvider({
        id: "custom-priority",
        variant: "chat_completions",
        apiKey: "from-direct",
        apiKeyEnv: envKey,
        models: [{ id: "m1" }],
      });

      const resolved = await provider.auth.apiKey?.resolve();
      expect(resolved).toBe("from-direct");
    } finally {
      delete process.env[envKey];
    }
  });

  it("resolves to dummy token in no-auth mode without throwing config errors", async () => {
    const provider = createCustomProvider({
      id: "ollama-local",
      variant: "chat_completions",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "mistral" }],
    });

    const resolved = await provider.auth.apiKey?.resolve();
    expect(resolved).toBe(LOCAL_RUNNER_NO_AUTH_KEY);
  });
});

describe("Model Capabilities & Directory Compatibility", () => {
  it("defaults capabilities to OPENAI_CHAT_COMPLETIONS_CAPABILITIES for chat_completions", () => {
    const provider = createCustomProvider({
      id: "custom-openai",
      variant: "chat_completions",
      models: [{ id: "model-1", name: "Custom GPT" }],
    });

    const models = provider.getModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("Custom GPT");
    expect(models[0]?.provider).toBe("custom-openai");
    expect(models[0]?.capabilities).toEqual(OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
  });

  it("defaults capabilities to ANTHROPIC_MESSAGES_CAPABILITIES for messages", () => {
    const provider = createCustomProvider({
      id: "custom-anthropic",
      variant: "messages",
      models: [{ id: "claude-custom" }],
    });

    const models = provider.getModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.provider).toBe("custom-anthropic");
    expect(models[0]?.capabilities).toEqual(ANTHROPIC_MESSAGES_CAPABILITIES);
  });

  it("applies per-model capability overrides accurately", () => {
    const provider = createCustomProvider({
      id: "custom-overrides",
      variant: "chat_completions",
      models: [
        {
          id: "m-whole",
          capabilities: {
            toolArgumentDelivery: "whole",
            serverSideTools: true,
          },
        },
      ],
    });

    const model = provider.getModels()[0];
    expect(model?.capabilities?.toolArgumentDelivery).toBe("whole");
    expect(model?.capabilities?.serverSideTools).toBe(true);
    expect(model?.capabilities?.parallelToolCallControl).toBe(
      OPENAI_CHAT_COMPLETIONS_CAPABILITIES.parallelToolCallControl,
    );
  });

  it("integrates seamlessly with ProviderDirectory", () => {
    const directory = new ProviderDirectory();
    const provider = createCustomProvider({
      id: "directory-custom",
      variant: "chat_completions",
      models: [{ id: "qwen-coder" }],
    });

    directory.setProvider(provider);
    expect(directory.getProvider("directory-custom")).toBe(provider);

    const lookedUpModel = directory.getModel("directory-custom", "qwen-coder");
    expect(lookedUpModel).toBeDefined();
    expect(lookedUpModel?.id).toBe("qwen-coder");
    expect(lookedUpModel?.provider).toBe("directory-custom");
  });

  it("freezes model objects and the models catalog defensively", () => {
    const provider = createCustomProvider({
      id: "frozen-test",
      variant: "chat_completions",
      models: [{ id: "m1" }],
    });

    const models = provider.getModels();
    expect(Object.isFrozen(models)).toBe(true);
    expect(Object.isFrozen(models[0])).toBe(true);
  });
});

describe("Wire Variant Mock Streaming", () => {
  const context: Context = { messages: [{ role: "user", content: "Hello" }] };

  it("routes chat_completions to openaiStream, streams text deltas and turn_end", async () => {
    mockOpenAIChunks = [
      { choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
      { choices: [{ delta: { content: "world!" }, finish_reason: "stop" }] },
    ];

    const provider = createCustomProvider({
      id: "my-openai",
      variant: "chat_completions",
      baseUrl: "https://my-proxy.local/v1",
      models: [{ id: "local-model" }],
    });

    const model = provider.getModels()[0] as Model;
    const stream = provider.stream(model, context);

    const turnEnd = await collectTurnEndEvent(stream);
    expect(turnEnd.message.content).toEqual([{ type: "text", text: "Hello world!" }]);
    expect(turnEnd.message.finishReason.reason).toBe("end_turn");
    expect(lastOpenAIClientOptions?.baseURL).toBe("https://my-proxy.local/v1");
  });

  it("delivers tool call across mock chat_completions endpoint", async () => {
    mockOpenAIChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-99",
                  type: "function",
                  function: { name: "edit_file", arguments: "" },
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
                  function: { arguments: '{"path":"file.ts"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const provider = createCustomProvider({
      id: "my-openai-tools",
      variant: "chat_completions",
      models: [{ id: "model-tools" }],
    });

    const model = provider.getModels()[0] as Model;
    const tools: ToolDeclaration[] = [
      {
        name: "edit_file",
        description: "Edit a file",
        parameters: {} as unknown as ToolDeclaration["parameters"],
      },
    ];

    const stream = provider.stream(model, { ...context, tools });
    const turnEnd = await collectTurnEndEvent(stream);

    expect(turnEnd.message.finishReason.reason).toBe("tool_call");
    expect(turnEnd.message.content).toEqual([
      {
        type: "tool_call",
        toolCallId: "call-99",
        name: "edit_file",
        arguments: '{"path":"file.ts"}',
      },
    ]);
  });

  it("routes messages to anthropicStream, streams text deltas and turn_end", async () => {
    mockAnthropicEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Anthropic response" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const provider = createCustomProvider({
      id: "my-anthropic",
      variant: "messages",
      baseUrl: "https://anthropic-proxy.local",
      headers: { "x-custom-org": "test-org" },
      models: [{ id: "custom-sonnet" }],
    });

    const model = provider.getModels()[0] as Model;
    const stream = provider.stream(model, context);

    const turnEnd = await collectTurnEndEvent(stream);
    expect(turnEnd.message.content).toEqual([{ type: "text", text: "Anthropic response" }]);
    expect(turnEnd.message.finishReason.reason).toBe("end_turn");
    expect(lastAnthropicClientOptions?.baseURL).toBe("https://anthropic-proxy.local");
    expect(lastAnthropicClientOptions?.defaultHeaders?.["x-custom-org"]).toBe("test-org");
  });

  it("delivers tool call across mock messages endpoint", async () => {
    mockAnthropicEvents = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_42",
          name: "read_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"path":"test.txt"}',
        },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
      { type: "message_stop" },
    ];

    const provider = createCustomProvider({
      id: "my-anthropic-tools",
      variant: "messages",
      models: [{ id: "custom-opus" }],
    });

    const model = provider.getModels()[0] as Model;
    const stream = provider.stream(model, context);
    const turnEnd = await collectTurnEndEvent(stream);

    expect(turnEnd.message.finishReason.reason).toBe("tool_call");
    expect(turnEnd.message.content).toEqual([
      {
        type: "tool_call",
        toolCallId: "toolu_42",
        name: "read_file",
        arguments: '{"path":"test.txt"}',
      },
    ]);
  });
});
