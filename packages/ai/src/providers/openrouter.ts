import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import OPENROUTER_MODELS from "@/providers/openrouter.models.json";
import type { Model, ModelCapabilities } from "@/types";

function withDefaultCapabilities(
  models: readonly { id: string; name: string; provider: string }[],
  capabilities: ModelCapabilities,
): Model[] {
  return models.map((m) => ({ ...m, capabilities }));
}

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
    models: withDefaultCapabilities(OPENROUTER_MODELS, OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES),
    api: { stream },
  });
}
