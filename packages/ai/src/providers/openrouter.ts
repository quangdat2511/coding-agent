import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { defineProvider, type Provider } from "@/models";
import OPENROUTER_MODELS from "@/providers/openrouter.models.json";
import type { Model } from "@/types";

export function createOpenRouterProvider(): Provider {
  return defineProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { apiKey: apiKeyFromEnv("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
    headers: {
      "HTTP-Referer": "https://github.com/quangdat2511/coding-agent",
      "X-Title": "Coding Agent",
    },
    models: OPENROUTER_MODELS as unknown as Model[],
    api: { stream },
  });
}
