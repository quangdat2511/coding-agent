import { describe, expect, it } from "bun:test";
import { defineProvider, ProviderDirectory } from "#src/models";
import type { Context, Model, StreamOptions } from "#src/types";
import { createModelEventStream } from "#src/utils/event-stream";

describe("ProviderDirectory", () => {
  const dummyModel: Model = {
    id: "test-model-1",
    name: "Test Model 1",
    provider: "mock-provider",
  };

  function createMockProvider(id = "mock-provider") {
    return {
      id,
      name: "Mock Provider",
      auth: {},
      getModels: () => [dummyModel],
      stream: (_model: Model, _context: Context, _options?: StreamOptions) => {
        return createModelEventStream();
      },
    };
  }

  it("should register and retrieve providers with setProvider and getProvider", () => {
    const registry = new ProviderDirectory();
    expect(registry.getProvider("mock-provider")).toBeUndefined();

    const provider = createMockProvider();
    registry.setProvider(provider);

    expect(registry.getProvider("mock-provider")).toBe(provider);
  });

  it("should get model by provider and model ID", () => {
    const registry = new ProviderDirectory();
    const provider = createMockProvider();
    registry.setProvider(provider);

    const found = registry.getModel("mock-provider", "test-model-1");
    expect(found).toBeDefined();
    expect(found?.id).toBe("test-model-1");

    expect(registry.getModel("mock-provider", "unknown-model")).toBeUndefined();
    expect(registry.getModel("unknown-provider", "test-model-1")).toBeUndefined();
  });

  it("should dispatch stream calls to the matching provider", () => {
    const registry = new ProviderDirectory();
    let streamCalledWith: { model: Model; context: Context; options?: StreamOptions } | undefined;

    const stream = createModelEventStream();
    registry.setProvider({
      id: "mock-provider",
      name: "Mock Provider",
      auth: {},
      getModels: () => [dummyModel],
      stream: (model, context, options) => {
        streamCalledWith = { model, context, options };
        return stream;
      },
    });

    const context: Context = {
      messages: [{ role: "user", content: "Hello" }],
    };
    const options: StreamOptions = { maxTokens: 100 };

    const resultStream = registry.stream(dummyModel, context, options);

    expect(resultStream).toBe(stream);
    expect(streamCalledWith as object).toEqual({ model: dummyModel, context, options });
  });

  it("should throw error when streaming with unregistered provider", () => {
    const registry = new ProviderDirectory();
    const context: Context = { messages: [] };

    expect(() => {
      registry.stream({ id: "m", name: "m", provider: "missing" }, context);
    }).toThrow("Provider missing not found");
  });
});

describe("defineProvider", () => {
  it("should default name to id if not provided", () => {
    const provider = defineProvider({
      id: "custom-id",
      auth: {},
      models: [],
      api: {
        stream: () => createModelEventStream(),
      },
    });

    expect(provider.id).toBe("custom-id");
    expect(provider.name).toBe("custom-id");
  });

  it("should merge options and resolve auth credentials during stream", async () => {
    let capturedOptions: StreamOptions | undefined;

    const provider = defineProvider({
      id: "auth-provider",
      baseUrl: "https://api.example.com",
      auth: {
        apiKey: {
          name: "Test Key",
          resolve: async () => "resolved-secret-key",
        },
      },
      models: [],
      api: {
        stream: (_model, _context, options) => {
          capturedOptions = options;
          return createModelEventStream();
        },
      },
    });

    const dummyModel: Model = { id: "m", name: "m", provider: "auth-provider" };
    const dummyContext: Context = { messages: [] };

    provider.stream(dummyModel, dummyContext, { maxTokens: 50 });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.maxTokens).toBe(50);
    expect(capturedOptions?.baseURL).toBe("https://api.example.com");
    expect(await capturedOptions?.apiKey).toBe("resolved-secret-key");
  });

  it("should allow explicit apiKey and baseURL overrides in StreamOptions", async () => {
    let capturedOptions: StreamOptions | undefined;

    const provider = defineProvider({
      id: "auth-provider",
      baseUrl: "https://api.example.com",
      auth: {
        apiKey: {
          name: "Test Key",
          resolve: async () => "default-key",
        },
      },
      models: [],
      api: {
        stream: (_model, _context, options) => {
          capturedOptions = options;
          return createModelEventStream();
        },
      },
    });

    const dummyModel: Model = { id: "m", name: "m", provider: "auth-provider" };
    const dummyContext: Context = { messages: [] };

    provider.stream(dummyModel, dummyContext, {
      apiKey: "custom-override-key",
      baseURL: "https://override.example.com",
    });

    expect(capturedOptions?.baseURL).toBe("https://override.example.com");
    expect(await capturedOptions?.apiKey).toBe("custom-override-key");
  });

  it("should merge static provider headers with caller headers during stream", () => {
    let capturedOptions: StreamOptions | undefined;

    const provider = defineProvider({
      id: "header-provider",
      auth: {},
      headers: {
        "X-Provider-Header": "provider-default",
        "X-Shared-Header": "from-provider",
      },
      models: [],
      api: {
        stream: (_model, _context, options) => {
          capturedOptions = options;
          return createModelEventStream();
        },
      },
    });

    const dummyModel: Model = { id: "m", name: "m", provider: "header-provider" };
    const dummyContext: Context = { messages: [] };

    provider.stream(dummyModel, dummyContext, {
      headers: {
        "X-Caller-Header": "caller-value",
        "X-Shared-Header": "from-caller",
      },
    });

    expect(capturedOptions?.headers).toEqual({
      "X-Provider-Header": "provider-default",
      "X-Caller-Header": "caller-value",
      "X-Shared-Header": "from-caller",
    });
  });

  it("should resolve dynamic header functions per stream call", () => {
    let callCount = 0;
    let capturedOptions: StreamOptions | undefined;

    const provider = defineProvider({
      id: "dynamic-header-provider",
      auth: {},
      headers: () => ({
        "X-Request-Id": `req-${++callCount}`,
      }),
      models: [],
      api: {
        stream: (_model, _context, options) => {
          capturedOptions = options;
          return createModelEventStream();
        },
      },
    });

    const dummyModel: Model = { id: "m", name: "m", provider: "dynamic-header-provider" };
    const dummyContext: Context = { messages: [] };

    provider.stream(dummyModel, dummyContext);
    expect(capturedOptions?.headers?.["X-Request-Id"]).toBe("req-1");

    provider.stream(dummyModel, dummyContext);
    expect(capturedOptions?.headers?.["X-Request-Id"]).toBe("req-2");
  });
});
