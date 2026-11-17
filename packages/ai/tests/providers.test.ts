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
  OPENCODE_GO_CHAT_COMPLETIONS_CAPABILITIES,
  OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
  XAI_CHAT_COMPLETIONS_CAPABILITIES,
} from "../src/index.ts";
import type { ApiVariant, ModelCapabilities } from "../src/types.ts";
import { loadFixture, sseResponse, withCapturingFixtureFetch } from "./fixtures/fixture-fetch.ts";

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
    const indexExports = await import("../src/index.ts");
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
        name: "opencode",
        factory: createOpencodeProvider,
        expectedCapabilities: OPENCODE_GO_CHAT_COMPLETIONS_CAPABILITIES,
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

    it("createXaiProvider accepts modelOverrides option", () => {
      const provider = createXaiProvider({
        modelOverrides: {
          "grok-4.3": { parallelToolCallControl: false, serverSideTools: true },
        },
      });
      expect(provider.variant).toBe("chat_completions");
      const models = provider.getModels();
      const grok43 = models.find((m) => m.id === "grok-4.3");
      expect(grok43).toBeDefined();
      expect(grok43?.capabilities?.parallelToolCallControl).toBe(false);
      expect(grok43?.capabilities?.serverSideTools).toBe(true);
      expect(grok43?.capabilities?.toolArgumentDelivery).toBe("whole");

      const other = models.find((m) => m.id !== "grok-4.3");
      expect(other?.capabilities).toEqual(XAI_CHAT_COMPLETIONS_CAPABILITIES);
    });
  });

  describe("createOpencodeProvider", () => {
    it("should initialize OpenCode Go provider with correct metadata and base URL", () => {
      const provider = createOpencodeProvider();

      expect(provider.id).toBe("opencode");
      expect(provider.name).toBe("OpenCode Go");
      // The SDK appends /chat/completions itself, so the root carries the OpenAI path only.
      expect(provider.baseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
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

    // The catalogue lists only models the Go gateway serves (its /models listing, 2026-11-17), so
    // `--model` refuses an id Go would reject at request time. Zen-only ids were removed.
    it("lists only models the Go gateway serves, adhering to the Model interface", () => {
      const models = createOpencodeProvider().getModels();

      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toBe("opencode");
      }
      expect(models.map((m) => m.id).sort()).toEqual(["deepseek-v4-pro", "deepseek-v4.1-flash"]);
    });

    // ADR 0007 Consequences: free-tier models are served only inside the OpenCode client, and every
    // other harness receives HTTP 403.
    it("lists no free-tier model, which an external harness cannot use", () => {
      const models = createOpencodeProvider().getModels();

      expect(models.filter((m) => m.id.endsWith("-free"))).toEqual([]);
    });

    // The provider's headers are a function, so each call is what one request would send.
    const headersOf = (provider: ReturnType<typeof createOpencodeProvider>) =>
      (provider.headers as () => Record<string, string>)();

    // ADR 0007 §6: Go reuses its prompt cache only when the session id stays the same for the
    // whole Agent Session, and one Agent Session streams through one provider instance.
    it("keeps x-opencode-session stable across calls on one instance", () => {
      const provider = createOpencodeProvider();
      expect(typeof provider.headers).toBe("function");

      const first = headersOf(provider)["x-opencode-session"];
      const second = headersOf(provider)["x-opencode-session"];

      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it("issues a different x-opencode-session for each instance", () => {
      const sessionOf = () => headersOf(createOpencodeProvider())["x-opencode-session"];

      expect(sessionOf()).not.toBe(sessionOf());
    });

    it("sends x-opencode-session instead of x-session-id", () => {
      const headers = headersOf(createOpencodeProvider());

      expect(headers).not.toHaveProperty("x-session-id");
      expect(Object.keys(headers)).toContain("x-opencode-session");
    });

    it("ignores OPENCODE_SESSION_ID, which would share one id between Agent Sessions", () => {
      const originalSession = process.env.OPENCODE_SESSION_ID;
      try {
        process.env.OPENCODE_SESSION_ID = "custom-session-123";
        const headers = headersOf(createOpencodeProvider());
        expect(headers["x-opencode-session"]).not.toBe("custom-session-123");
      } finally {
        if (originalSession === undefined) {
          delete process.env.OPENCODE_SESSION_ID;
        } else {
          process.env.OPENCODE_SESSION_ID = originalSession;
        }
      }
    });

    // The conformance suite calls the adapter directly, below defineProvider, so it never sees
    // the base URL or the provider headers. This sends a recorded request through both.
    it("sends the Go URL, the session header and the caller's user agent on the wire", async () => {
      const provider = createOpencodeProvider();
      const model = provider.getModels().find((m) => m.id === "deepseek-v4.1-flash");
      expect(model).toBeDefined();
      if (model === undefined) return;

      await withCapturingFixtureFetch(
        sseResponse(loadFixture("opencode/text-streaming.txt")),
        async (captured) => {
          const result = await provider
            .stream(
              model,
              { messages: [{ role: "user", content: "Hello" }] },
              { apiKey: "test-key", headers: { "user-agent": "coding-agent/9.9.9" } },
            )
            .result();

          expect(result.finishReason.reason).toBe("end_turn");
          expect(captured).toHaveLength(1);
          const [request] = captured;
          expect(request?.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
          expect(request?.headers["user-agent"]).toBe("coding-agent/9.9.9");
          expect(request?.headers["x-opencode-session"]).toBeTruthy();
          expect(request?.headers).not.toHaveProperty("x-session-id");
        },
      );
    });

    it("sends the same x-opencode-session on every request of one instance", async () => {
      const provider = createOpencodeProvider();
      const model = provider.getModels().find((m) => m.id === "deepseek-v4.1-flash");
      if (model === undefined) throw new Error("deepseek-v4.1-flash is not in the catalogue");

      await withCapturingFixtureFetch(
        () => sseResponse(loadFixture("opencode/text-streaming.txt")),
        async (captured) => {
          for (let turn = 0; turn < 3; turn++) {
            await provider
              .stream(model, { messages: [{ role: "user", content: "Hello" }] }, { apiKey: "k" })
              .result();
          }

          const sessions = captured.map((request) => request.headers["x-opencode-session"]);
          expect(sessions).toHaveLength(3);
          expect(new Set(sessions).size).toBe(1);
        },
      );
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

  describe("createOpenAIProvider", () => {
    it("should initialize OpenAI provider with correct metadata and base URL", () => {
      const provider = createOpenAIProvider();

      expect(provider.id).toBe("openai");
      expect(provider.name).toBe("OpenAI");
      expect(provider.baseUrl).toBe("https://api.openai.com/v1");
      expect(provider.variant).toBe("chat_completions");
    });

    it("should accept variant option explicitly", () => {
      const provider = createOpenAIProvider({ variant: "chat_completions" });
      expect(provider.variant).toBe("chat_completions");
    });

    it("should resolve API key from OPENAI_API_KEY", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      try {
        process.env.OPENAI_API_KEY = "test-openai-key-456";
        const provider = createOpenAIProvider();
        expect(await provider.auth.apiKey?.resolve()).toBe("test-openai-key-456");
      } finally {
        if (originalKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it("should contain OpenAI models with default capabilities", () => {
      const provider = createOpenAIProvider();
      const models = provider.getModels();

      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toBe("openai");
        expect(model.capabilities).toEqual(OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
      }

      const modelIds = new Set(models.map((m) => m.id));
      expect(modelIds.has("gpt-4o")).toBe(true);
      expect(modelIds.has("gpt-4o-mini")).toBe(true);
      expect(modelIds.has("o1")).toBe(true);
    });
  });

  describe("createXaiProvider", () => {
    it("should initialize xAI provider with correct metadata and base URL", () => {
      const provider = createXaiProvider();

      expect(provider.id).toBe("xai");
      expect(provider.name).toBe("xAI (Grok)");
      expect(provider.baseUrl).toBe("https://api.x.ai/v1");
      expect(provider.variant).toBe("chat_completions");
    });

    it("should accept variant option explicitly", () => {
      const provider = createXaiProvider({ variant: "chat_completions" });
      expect(provider.variant).toBe("chat_completions");
    });

    it("should resolve API key from XAI_API_KEY", async () => {
      const originalKey = process.env.XAI_API_KEY;
      try {
        process.env.XAI_API_KEY = "test-xai-key-789";
        const provider = createXaiProvider();
        expect(await provider.auth.apiKey?.resolve()).toBe("test-xai-key-789");
      } finally {
        if (originalKey === undefined) {
          delete process.env.XAI_API_KEY;
        } else {
          process.env.XAI_API_KEY = originalKey;
        }
      }
    });

    it("should contain xAI models with default capabilities", () => {
      const provider = createXaiProvider();
      const models = provider.getModels();

      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
        expect(model.provider).toBe("xai");
        expect(model.capabilities).toEqual(XAI_CHAT_COMPLETIONS_CAPABILITIES);
      }

      const modelIds = new Set(models.map((m) => m.id));
      expect(modelIds.has("grok-4.3")).toBe(true);
      expect(modelIds.has("grok-build-0.1")).toBe(true);
      expect(modelIds.has("grok-4.5")).toBe(true);
    });
  });

  describe("createProviderDirectory registry", () => {
    it("should find models across providers", () => {
      const models = createProviderDirectory();

      const opencodeModel = models.getModel("opencode", "deepseek-v4.1-flash");
      expect(opencodeModel).toBeDefined();
      expect(opencodeModel?.name).toBe("DeepSeek V4.1 Flash");

      const openaiModel = models.getModel("openai", "gpt-4o");
      expect(openaiModel).toBeDefined();

      const anthropicModel = models.getModel("anthropic", "claude-sonnet-4-5");
      expect(anthropicModel).toBeDefined();

      const openrouterModel = models.getModel("openrouter", "openai/gpt-4o");
      expect(openrouterModel).toBeDefined();

      const xaiModel = models.getModel("xai", "grok-4.3");
      expect(xaiModel).toBeDefined();
    });
  });
});
