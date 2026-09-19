import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { applyCapabilities, OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import OPENROUTER_MODELS from "@/providers/openrouter.models.json";
import type { ModelCapabilities } from "@/types";

export interface OpenRouterProviderOptions {
  variant?: "chat_completions";
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export function createOpenRouterProvider(options?: OpenRouterProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES;

  return defineProvider({
    id: "openrouter",
    name: "OpenRouter",
    variant,
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { apiKey: apiKeyFromEnv("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
    headers: {
      "HTTP-Referer": "https://github.com/quangdat2511/coding-agent",
      "X-Title": "Coding Agent",
    },
    models: applyCapabilities(OPENROUTER_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
