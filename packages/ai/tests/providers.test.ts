import { describe, expect, it } from "bun:test";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAIProvider,
  createOpencodeProvider,
  createOpenRouterProvider,
  createProviderDirectory,
  createXaiProvider,
  defaultProviders,
  GOOGLE_GENERATE_CONTENT_CAPABILITIES,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
  XAI_CHAT_COMPLETIONS_CAPABILITIES,
} from "@/index";
import type { ApiVariant, ModelCapabilities } from "@/types";

describe("Built-in Providers & Registry", () => {
  it("should register all 6 built-in providers in defaultProviders()", () => {
    const providers = defaultProviders();
    const providerIds = providers.map((p) => p.id);

    expect(providerIds).toEqual(["anthropic", "google", "openai", "opencode", "openrouter", "xai"]);
  });

  it("should export all provider factories from index", () => {
    expect(typeof createAnthropicProvider).toBe("function");
    expect(typeof createGoogleProvider).toBe("function");
    expect(typeof createOpenAIProvider).toBe("function");
    expect(typeof createOpencodeProvider).toBe("function");
    expect(typeof createOpenRouterProvider).toBe("function");
    expect(typeof createXaiProvider).toBe("function");
    expect(typeof defaultProviders).toBe("function");
    expect(typeof createProviderDirectory).toBe("function");
  });

  it("should keep EventStream helpers internal and unexported from index", async () => {
    const indexExports = await import("@/index");
    expect((indexExports as Record<string, unknown>).EventStream).toBeUndefined();
    expect((indexExports as Record<string, unknown>).AssistantMessageEventStream).toBeUndefined();
    expect(
      (indexExports as Record<string, unknown>).createAssistantMessageEventStream,
    ).toBeUndefined();
    expect((indexExports as Record<string, unknown>).ModelEventStream).toBeUndefined();
    expect((indexExports as Record<string, unknown>).createModelEventStream).toBeUndefined();
    expect((indexExports as Record<string, unknown>).sanitizeMaxRetries).toBeUndefined();
  });

  describe("MVP provider capabilities", () => {
    const mvpProviders: {
      name: string;
      factory: () => ReturnType<typeof createAnthropicProvider>;
      expectedCapabilities: ModelCapabilities;
      expectedVariant: ApiVariant;
    }[] = [
      {
        name: "anthropic",
        factory: createAnthropicProvider,
        expectedCapabilities: ANTHROPIC_MESSAGES_CAPABILITIES,
        expectedVariant: "messages",
      },
      {
        name: "google",
        factory: createGoogleProvider,
        expectedCapabilities: GOOGLE_GENERATE_CONTENT_CAPABILITIES,
        expectedVariant: "generate_content",
      },
      {
        name: "openai",
        factory: createOpenAIProvider,
        expectedCapabilities: OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
        expectedVariant: "chat_completions",
      },
      {
        name: "openrouter",
        factory: createOpenRouterProvider,
        expectedCapabilities: OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
        expectedVariant: "chat_completions",
      },
      {
        name: "xai",
        factory: createXaiProvider,
        expectedCapabilities: XAI_CHAT_COMPLETIONS_CAPABILITIES,
        expectedVariant: "chat_completions",
      },
    ];

    for (const { name, factory, expectedCapabilities, expectedVariant } of mvpProviders) {
      it(`every ${name} model has capabilities matching its variant default and variant is ${expectedVariant}`, () => {
        const provider = factory();
        expect(provider.variant).toBe(expectedVariant);
        const models = provider.getModels();
        expect(models.length).toBeGreaterThan(0);

        for (const model of models) {
          expect(model.capabilities).toBeDefined();
          expect(model.capabilities).toEqual(expectedCapabilities);
        }
      });
    }

    it("createOpenAIProvider accepts modelOverrides option", () => {
      const provider = createOpenAIProvider({
        modelOverrides: {
          "gpt-4o": { parallelToolCallControl: false, serverSideTools: true },
        },
      });
      expect(provider.variant).toBe("chat_completions");
      const models = provider.getModels();
      const gpt4o = models.find((m) => m.id === "gpt-4o");
      expect(gpt4o).toBeDefined();
      expect(gpt4o?.capabilities?.parallelToolCallControl).toBe(false);
      expect(gpt4o?.capabilities?.serverSideTools).toBe(true);
      expect(gpt4o?.capabilities?.toolArgumentDelivery).toBe("streamed");

      const other = models.find((m) => m.id !== "gpt-4o");
      expect(other?.capabilities).toEqual(OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
    });

    it("createAnthropicProvider accepts modelOverrides option", () => {
      const provider = createAnthropicProvider({
        modelOverrides: {
          "claude-sonnet-4-5": { serverSideTools: true },
        },
      });
      expect(provider.variant).toBe("messages");
      const models = provider.getModels();
      const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");
      expect(sonnet).toBeDefined();
      expect(sonnet?.capabilities?.serverSideTools).toBe(true);

      const other = models.find((m) => m.id !== "claude-sonnet-4-5");
      expect(other?.capabilities).toEqual(ANTHROPIC_MESSAGES_CAPABILITIES);
    });
  });

  describe("opencode is not an MVP provider", () => {
    it("opencode models do not have capabilities set", () => {
      const provider = createOpencodeProvider();
      const models = provider.getModels();
      expect(models.length).toBeGreaterThan(0);

      for (const model of models) {
        expect(model.capabilities).toBeUndefined();
      }
    });
  });

  describe("createOpencodeProvider", () => {
    it("should initialize OpenCode Zen provider with correct metadata and base URL", () => {
      const provider = createOpencodeProvider();

      expect(provider.id).toBe("opencode");
      expect(provider.name).toBe("OpenCode Zen");
      expect(provider.baseUrl).toBe("https://opencode.ai/zen/v1");
    });

    it("should resolve API key from OPENCODE_API_KEY", async () => {
      const originalKey = process.env.OPENCODE_API_KEY;
      try {
        process.env.OPENCODE_API_KEY = "test-opencode-key-123";
        const provider = createOpencodeProvider();
        expect(await provider.auth.apiKey?.resolve()).toBe("test-opencode-key-123");
      } finally {
        if (originalKey === undefined) {
          delete process.env.OPENCODE_API_KEY;
        } else {
          process.env.OPENCODE_API_KEY = originalKey;
        }
      }
    });

    it("should contain 35 models adhering to Model interface", () => {
      const provider = createOpencodeProvider();
      const models = provider.getModels();

      expect(models.length).toBe(35);
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toBe("opencode");
      }

      const modelIds = new Set(models.map((m) => m.id));
      expect(modelIds.has("deepseek-v4-flash")).toBe(true);
      expect(modelIds.has("gpt-5")).toBe(true);
      expect(modelIds.has("qwen3.6-plus")).toBe(true);
      expect(modelIds.has("big-pickle")).toBe(true);
    });

    it("should configure dynamic x-session-id in headers", () => {
      const provider = createOpencodeProvider();
      expect(typeof provider.headers).toBe("function");

      const headersFn = provider.headers as () => Record<string, string>;
      const h1 = headersFn();
      const h2 = headersFn();

      expect(h1["x-session-id"]).toBeDefined();
      expect(h2["x-session-id"]).toBeDefined();
      expect(h1["x-session-id"]).not.toBe(h2["x-session-id"]);
    });

    it("should respect OPENCODE_SESSION_ID when set", () => {
      const originalSession = process.env.OPENCODE_SESSION_ID;
      try {
        process.env.OPENCODE_SESSION_ID = "custom-session-123";
        const provider = createOpencodeProvider();
        const headersFn = provider.headers as () => Record<string, string>;
        expect(headersFn()["x-session-id"]).toBe("custom-session-123");
      } finally {
        if (originalSession === undefined) {
          delete process.env.OPENCODE_SESSION_ID;
        } else {
          process.env.OPENCODE_SESSION_ID = originalSession;
        }
      }
    });
  });

  describe("createOpenRouterProvider", () => {
    it("should configure default HTTP-Referer and X-Title headers", () => {
      const provider = createOpenRouterProvider();
      expect(provider.headers).toEqual({
        "HTTP-Referer": "https://github.com/quangdat2511/coding-agent",
        "X-Title": "Coding Agent",
      });
    });
  });

  describe("createProviderDirectory registry", () => {
    it("should find models across providers", () => {
      const models = createProviderDirectory();

      const opencodeModel = models.getModel("opencode", "gpt-5");
      expect(opencodeModel).toBeDefined();
      expect(opencodeModel?.name).toBe("GPT-5");

      const openaiModel = models.getModel("openai", "gpt-4o");
      expect(openaiModel).toBeDefined();

      const anthropicModel = models.getModel("anthropic", "claude-sonnet-4-5");
      expect(anthropicModel).toBeDefined();

      const openrouterModel = models.getModel("openrouter", "openai/gpt-4o");
      expect(openrouterModel).toBeDefined();
    });
  });
});
