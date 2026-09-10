import { describe, expect, it } from "bun:test";
import {
  anthropicProvider,
  builtinModels,
  builtinProviders,
  googleProvider,
  openaiProvider,
  opencodeProvider,
  openrouterProvider,
  xaiProvider,
} from "@/index";

describe("Built-in Providers & Registry", () => {
  it("should register all 6 built-in providers in builtinProviders()", () => {
    const providers = builtinProviders();
    const providerIds = providers.map((p) => p.id);

    expect(providerIds).toEqual(["anthropic", "google", "openai", "opencode", "openrouter", "xai"]);
  });

  it("should export all provider factories from index", () => {
    expect(typeof anthropicProvider).toBe("function");
    expect(typeof googleProvider).toBe("function");
    expect(typeof openaiProvider).toBe("function");
    expect(typeof opencodeProvider).toBe("function");
    expect(typeof openrouterProvider).toBe("function");
    expect(typeof xaiProvider).toBe("function");
    expect(typeof builtinProviders).toBe("function");
    expect(typeof builtinModels).toBe("function");
  });

  describe("opencodeProvider", () => {
    it("should initialize OpenCode Zen provider with correct metadata and base URL", () => {
      const provider = opencodeProvider();

      expect(provider.id).toBe("opencode");
      expect(provider.name).toBe("OpenCode Zen");
      expect(provider.baseUrl).toBe("https://opencode.ai/zen/v1");
    });

    it("should resolve API key from OPENCODE_API_KEY", async () => {
      const originalKey = process.env.OPENCODE_API_KEY;
      try {
        process.env.OPENCODE_API_KEY = "test-opencode-key-123";
        const provider = opencodeProvider();
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
      const provider = opencodeProvider();
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
      const provider = opencodeProvider();
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
        const provider = opencodeProvider();
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

  describe("openrouterProvider", () => {
    it("should configure default HTTP-Referer and X-Title headers", () => {
      const provider = openrouterProvider();
      expect(provider.headers).toEqual({
        "HTTP-Referer": "https://github.com/quangdat2511/coding-agent",
        "X-Title": "Coding Agent",
      });
    });
  });

  describe("builtinModels registry", () => {
    it("should find models across providers", () => {
      const models = builtinModels();

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
