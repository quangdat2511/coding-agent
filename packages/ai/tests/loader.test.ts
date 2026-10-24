import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CustomProviderValidationError,
  loadCustomProvidersFromFile,
  ProviderDirectory,
  parseCustomProviderConfigs,
  registerCustomProvidersFromFile,
} from "../src/index.ts";

describe("Custom Provider File Loader", () => {
  const tempFiles: string[] = [];

  function createTempConfigFile(content: string): string {
    const filePath = join(
      import.meta.dir,
      `.temp-models-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(filePath, content, "utf-8");
    tempFiles.push(filePath);
    return filePath;
  }

  afterEach(() => {
    for (const file of tempFiles) {
      try {
        rmSync(file, { force: true });
      } catch {
        // ignore cleanup error
      }
    }
    tempFiles.length = 0;
  });

  describe("parseCustomProviderConfigs", () => {
    it("parses valid array format config", () => {
      const json = JSON.stringify([
        {
          id: "local-ollama",
          variant: "chat_completions",
          baseUrl: "http://localhost:11434/v1",
          models: [{ id: "*" }],
        },
      ]);

      const configs = parseCustomProviderConfigs(json);
      expect(configs).toHaveLength(1);
      expect(configs[0]?.id).toBe("local-ollama");
      expect(configs[0]?.variant).toBe("chat_completions");
      expect(configs[0]?.models[0]?.id).toBe("*");
    });

    it("parses valid providers map format config (Pi style)", () => {
      const json = JSON.stringify({
        providers: {
          "deepseek-proxy": {
            variant: "chat_completions",
            baseUrl: "https://api.deepseek.com",
            apiKey: "$DEEPSEEK_API_KEY",
            models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
          },
        },
      });

      const configs = parseCustomProviderConfigs(json);
      expect(configs).toHaveLength(1);
      expect(configs[0]?.id).toBe("deepseek-proxy");
      expect(configs[0]?.apiKey).toBe("$DEEPSEEK_API_KEY");
      expect(configs[0]?.models).toHaveLength(2);
    });

    it("throws CustomProviderValidationError on malformed JSON syntax", () => {
      expect(() => parseCustomProviderConfigs("{ not valid json")).toThrow(
        CustomProviderValidationError,
      );
    });

    it("throws CustomProviderValidationError on invalid array entry", () => {
      const invalidJson = JSON.stringify([
        {
          id: "bad-entry",
          // missing variant and models
        },
      ]);

      expect(() => parseCustomProviderConfigs(invalidJson)).toThrow(CustomProviderValidationError);
    });

    it("throws CustomProviderValidationError on invalid map entry", () => {
      const invalidJson = JSON.stringify({
        providers: {
          "bad-map": {
            variant: "invalid_variant",
            models: [],
          },
        },
      });

      expect(() => parseCustomProviderConfigs(invalidJson)).toThrow(CustomProviderValidationError);
    });
  });

  describe("loadCustomProvidersFromFile & registerCustomProvidersFromFile", () => {
    it("returns an empty array when configuration file does not exist", () => {
      const nonExistentPath = join(import.meta.dir, "does-not-exist-models.json");
      const providers = loadCustomProvidersFromFile(nonExistentPath);
      expect(providers).toEqual([]);
    });

    it("loads and instantiates providers from valid JSON file", () => {
      const filePath = createTempConfigFile(
        JSON.stringify([
          {
            id: "file-provider-1",
            variant: "chat_completions",
            models: [{ id: "model-a" }],
          },
        ]),
      );

      const providers = loadCustomProvidersFromFile(filePath);
      expect(providers).toHaveLength(1);
      expect(providers[0]?.id).toBe("file-provider-1");
      expect(providers[0]?.getModels()).toHaveLength(1);
    });

    it("registers custom providers directly into a ProviderDirectory", () => {
      const filePath = createTempConfigFile(
        JSON.stringify({
          providers: {
            "registered-provider": {
              variant: "chat_completions",
              baseUrl: "http://localhost:8000/v1",
              models: [{ id: "model-b" }, { id: "*" }],
            },
          },
        }),
      );

      const directory = new ProviderDirectory();
      const registered = registerCustomProvidersFromFile(directory, filePath);

      expect(registered).toHaveLength(1);
      expect(directory.getProvider("registered-provider")).toBeDefined();

      const exactModel = directory.getModel("registered-provider", "model-b");
      expect(exactModel).toBeDefined();
      expect(exactModel?.id).toBe("model-b");

      const dynamicModel = directory.getModel("registered-provider", "any-random-id");
      expect(dynamicModel).toBeDefined();
      expect(dynamicModel?.id).toBe("any-random-id");
    });
  });
});
