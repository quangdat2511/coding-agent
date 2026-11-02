import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
} from "../src/capabilities.ts";
import { ProviderDirectory } from "../src/models.ts";
import {
  CustomModelConfigSchema,
  CustomProviderConfigSchema,
  CustomProviderValidationError,
  CustomProviderVariantSchema,
  createCustomProvider,
} from "../src/providers/custom.ts";
import type { Context, Model, ModelStream, ModelStreamEvent } from "../src/types.ts";

type TurnEndEvent = Extract<ModelStreamEvent, { type: "turn_end" }>;

// Helper to collect the terminal turn_end event from a stream
async function collectTurnEndEvent(stream: ModelStream): Promise<TurnEndEvent> {
  let turnEnd: TurnEndEvent | undefined;
  for await (const event of stream) {
    if (event.type === "turn_end") {
      turnEnd = event;
    }
  }
  if (!turnEnd) {
    throw new Error("Stream finished without turn_end event");
  }
  return turnEnd;
}

// Helper to assert ADR 0004 §1 error discriminant
function expectValidationError(fn: () => unknown): CustomProviderValidationError {
  try {
    fn();
    throw new Error("Expected CustomProviderValidationError to be thrown");
  } catch (err: unknown) {
    const errorRecord = err as { code?: string; message?: string; errors?: string[] };
    expect(errorRecord.code).toBe("INVALID_CUSTOM_PROVIDER_CONFIG");
    expect(err).toBeInstanceOf(CustomProviderValidationError);
    return err as CustomProviderValidationError;
  }
}

// --- OpenAI Mocks ---
type OpenAIChunk = Record<string, unknown>;
let mockOpenAIChunks: OpenAIChunk[] = [];
let lastOpenAIClientOptions: { baseURL?: string } | undefined;
let openAISpy: { mockRestore: () => void } | undefined;

// --- Anthropic Mocks ---
type AnthropicStreamEvent = Record<string, unknown>;
let mockAnthropicEvents: AnthropicStreamEvent[] = [];
let lastAnthropicClientOptions: { baseURL?: string } | undefined;
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
        fn: (this: { _client: { baseURL?: string } }, body: unknown, options?: unknown) => unknown,
      ) => { mockRestore: () => void };
    }
  ).mockImplementation(async function (this: { _client: { baseURL?: string } }) {
    lastAnthropicClientOptions = {
      baseURL: this._client.baseURL,
    };
    return (async function* () {
      for (const event of mockAnthropicEvents) {
        yield event;
      }
    })();
  });
});

afterEach(() => {
  mockOpenAIChunks = [];
  lastOpenAIClientOptions = undefined;
  mockAnthropicEvents = [];
  lastAnthropicClientOptions = undefined;
});

afterAll(() => {
  openAISpy?.mockRestore();
  anthropicSpy?.mockRestore();
});

describe("Custom Provider Schema & Validation", () => {
  it("exports schemas and validator error class with discriminant code", () => {
    expect(CustomModelConfigSchema).toBeDefined();
    expect(CustomProviderConfigSchema).toBeDefined();
    expect(CustomProviderVariantSchema).toBeDefined();
    expect(CustomProviderValidationError).toBeDefined();

    const err = new CustomProviderValidationError("test", ["error 1"]);
    expect(err.code).toBe("INVALID_CUSTOM_PROVIDER_CONFIG");
    expect(err.name).toBe("CustomProviderValidationError");
    expect(err.errors).toEqual(["error 1"]);
  });

  it("throws CustomProviderValidationError with code discriminant on invalid configuration", () => {
    // Missing id
    expectValidationError(() =>
      createCustomProvider({
        id: "",
        variant: "chat_completions",
        apiKey: "valid-key",
        models: [{ id: "m1" }],
      }),
    );

    // Invalid variant
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        // @ts-expect-error test invalid variant runtime validation
        variant: "unsupported_variant",
        apiKey: "valid-key",
        models: [{ id: "m1" }],
      }),
    );

    // Empty models array
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "valid-key",
        models: [],
      }),
    );

    // Empty model id
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "valid-key",
        models: [{ id: "" }],
      }),
    );

    // Empty apiKey
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "",
        models: [{ id: "m1" }],
      }),
    );

    // Whitespace-only apiKey
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "   ",
        models: [{ id: "m1" }],
      }),
    );

    // Whitespace-only apiKeyEnv
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKeyEnv: "   ",
        models: [{ id: "m1" }],
      }),
    );

    // Local runner without apiKey or apiKeyEnv requires baseUrl
    expectValidationError(() =>
      createCustomProvider({
        id: "no-auth-missing-baseurl",
        variant: "chat_completions",
        models: [{ id: "m1" }],
      }),
    );

    // Whitespace-only id
    expectValidationError(() =>
      createCustomProvider({
        id: "   ",
        variant: "chat_completions",
        apiKey: "valid-key",
        models: [{ id: "m1" }],
      }),
    );

    // Whitespace-only baseUrl
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        baseUrl: "   ",
        apiKey: "valid-key",
        models: [{ id: "m1" }],
      }),
    );

    // Whitespace-only model id
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "valid-key",
        models: [{ id: "   " }],
      }),
    );

    // Invalid apiKeyEnv pattern (e.g. starts with digit or has spaces)
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKeyEnv: "123_INVALID",
        models: [{ id: "m1" }],
      }),
    );

    // Unknown top-level property rejected by strict schema
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "valid-key",
        models: [{ id: "m1" }],
        // @ts-expect-error test unknown top-level property
        unknownTopLevelField: true,
      }),
    );

    // Unknown capability property rejected by strict schema
    expectValidationError(() =>
      createCustomProvider({
        id: "test",
        variant: "chat_completions",
        apiKey: "valid-key",
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
    );
  });

  it("instantiates provider with valid minimal config with explicit key", () => {
    const provider = createCustomProvider({
      id: "minimal-provider",
      variant: "chat_completions",
      apiKey: "sk-test-123",
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

  it("instantiates provider with valid unauthenticated local runner and baseUrl", () => {
    const provider = createCustomProvider({
      id: "minimal-local",
      variant: "chat_completions",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "llama3" }],
    });

    expect(provider.id).toBe("minimal-local");
    expect(provider.baseUrl).toBe("http://localhost:11434/v1");
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
  it("resolves explicit apiKey directly", async () => {
    const provider = createCustomProvider({
      id: "custom-auth",
      variant: "chat_completions",
      apiKey: "secret-key-123",
      models: [{ id: "m1" }],
    });

    const resolved = await provider.auth.apiKey?.resolve();
    expect(resolved).toBe("secret-key-123");
    expect(provider.auth.apiKey?.envVars).toBeUndefined();
  });

  it("resolves apiKeyEnv from environment variables and trims variable value whitespace", async () => {
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
      expect(provider.auth.apiKey?.envVars).toEqual([envKey]);
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
    expect(provider.auth.apiKey?.envVars).toEqual([missingEnv]);
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
      expect(provider.auth.apiKey?.envVars).toEqual([envKey]);
    } finally {
      delete process.env[envKey];
    }
  });

  it("resolves to dummy token in no-auth mode when baseUrl is provided", async () => {
    const provider = createCustomProvider({
      id: "ollama-local",
      variant: "chat_completions",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "mistral" }],
    });

    const resolved = await provider.auth.apiKey?.resolve();
    expect(resolved).toBe("no-key");
    expect(provider.auth.apiKey?.envVars).toBeUndefined();
  });
});

describe("Model Capabilities & Directory Compatibility", () => {
  it("defaults capabilities to OPENAI_CHAT_COMPLETIONS_CAPABILITIES for chat_completions", () => {
    const provider = createCustomProvider({
      id: "custom-openai",
      variant: "chat_completions",
      apiKey: "test-key",
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
      apiKey: "test-key",
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
      apiKey: "test-key",
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
      apiKey: "test-key",
      models: [{ id: "qwen-coder" }],
    });

    directory.setProvider(provider);
    expect(directory.getProvider("directory-custom")).toBe(provider);

    const lookedUpModel = directory.getModel("directory-custom", "qwen-coder");
    expect(lookedUpModel).toBeDefined();
    expect(lookedUpModel?.id).toBe("qwen-coder");
    expect(lookedUpModel?.provider).toBe("directory-custom");
  });

  it("defaults model name to model id when name is omitted", () => {
    const provider = createCustomProvider({
      id: "unnamed-model-provider",
      variant: "chat_completions",
      apiKey: "test-key",
      models: [{ id: "model-without-name" }],
    });

    const model = provider.getModels()[0];
    expect(model?.name).toBe("model-without-name");
  });

  it("defaults provider name to provider id when name is omitted", () => {
    const provider = createCustomProvider({
      id: "unnamed-provider",
      variant: "chat_completions",
      apiKey: "test-key",
      models: [{ id: "m1" }],
    });

    expect(provider.name).toBe("unnamed-provider");
  });

  it("returns undefined for unknown models or unknown providers (strict exact match)", () => {
    const directory = new ProviderDirectory();
    const provider = createCustomProvider({
      id: "strict-provider",
      variant: "chat_completions",
      apiKey: "test-key",
      models: [{ id: "known-model" }],
    });
    directory.setProvider(provider);

    expect(directory.getModel("strict-provider", "known-model")).toBeDefined();
    expect(directory.getModel("strict-provider", "unknown-model")).toBeUndefined();
    expect(directory.getModel("unknown-provider", "known-model")).toBeUndefined();
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
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"loc' },
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
                  function: { arguments: 'ation":"Paris"}' },
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
      baseUrl: "https://mock-openai.local/v1",
      models: [{ id: "function-model" }],
    });

    const model = provider.getModels()[0] as Model;
    const stream = provider.stream(model, context);

    const turnEnd = await collectTurnEndEvent(stream);
    expect(turnEnd.message.finishReason.reason).toBe("tool_call");
    expect(turnEnd.message.content).toEqual([
      {
        type: "tool_call",
        toolCallId: "call_abc",
        name: "get_weather",
        arguments: '{"location":"Paris"}',
      },
    ]);
  });

  it("routes messages to anthropicStream with custom headers and baseURL", async () => {
    mockAnthropicEvents = [
      {
        type: "message_start",
        message: {
          id: "msg_123",
          role: "assistant",
          content: [],
          model: "custom-sonnet",
          usage: { input_tokens: 15, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Anthropic response" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      {
        type: "message_stop",
      },
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
    expect(provider.headers).toEqual({ "x-custom-org": "test-org" });
    expect(lastAnthropicClientOptions?.baseURL).toBe("https://anthropic-proxy.local");
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
          partial_json: '{"path":"src/index.ts"}',
        },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
      },
      {
        type: "message_stop",
      },
    ];

    const provider = createCustomProvider({
      id: "my-anthropic-tools",
      variant: "messages",
      baseUrl: "https://anthropic-proxy.local",
      models: [{ id: "tool-sonnet" }],
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
        arguments: '{"path":"src/index.ts"}',
      },
    ]);
  });

  it("maps OpenAI finish reason 'length' to 'max_output_tokens'", async () => {
    mockOpenAIChunks = [
      { choices: [{ delta: { content: "Truncated output" }, finish_reason: "length" }] },
    ];

    const provider = createCustomProvider({
      id: "openai-length",
      variant: "chat_completions",
      baseUrl: "https://my-proxy.local/v1",
      models: [{ id: "length-model" }],
    });

    const model = provider.getModels()[0] as Model;
    const stream = provider.stream(model, context);

    const turnEnd = await collectTurnEndEvent(stream);
    expect(turnEnd.message.finishReason.reason).toBe("max_output_tokens");
    expect(turnEnd.message.finishReason.rawReason).toBe("length");
  });

  it("maps Anthropic stop reason 'max_tokens' to 'max_output_tokens'", async () => {
    mockAnthropicEvents = [
      {
        type: "message_start",
        message: {
          id: "msg_tokens",
          role: "assistant",
          content: [],
          model: "sonnet-tokens",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Token cap" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 100 },
      },
      {
        type: "message_stop",
      },
    ];

    const provider = createCustomProvider({
      id: "anthropic-max-tokens",
      variant: "messages",
      baseUrl: "https://anthropic-proxy.local",
      models: [{ id: "sonnet-tokens" }],
    });

    const model = provider.getModels()[0] as Model;
    const stream = provider.stream(model, context);

    const turnEnd = await collectTurnEndEvent(stream);
    expect(turnEnd.message.finishReason.reason).toBe("max_output_tokens");
    expect(turnEnd.message.finishReason.rawReason).toBe("max_tokens");
  });
});
