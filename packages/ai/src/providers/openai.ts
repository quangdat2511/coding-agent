import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { applyCapabilities, OPENAI_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import OPENAI_MODELS from "@/providers/openai.models.json";
import type { ModelCapabilities } from "@/types";

export interface OpenAIProviderOptions {
  variant?: "chat_completions";
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export function createOpenAIProvider(options?: OpenAIProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = OPENAI_CHAT_COMPLETIONS_CAPABILITIES;

  return defineProvider({
    id: "openai",
    name: "OpenAI",
    variant,
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: apiKeyFromEnv("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: applyCapabilities(OPENAI_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
