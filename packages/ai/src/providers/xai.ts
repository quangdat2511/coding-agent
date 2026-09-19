import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { applyCapabilities, XAI_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import XAI_MODELS from "@/providers/xai.models.json";
import type { ModelCapabilities } from "@/types";

export interface XaiProviderOptions {
  variant?: "chat_completions";
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export function createXaiProvider(options?: XaiProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = XAI_CHAT_COMPLETIONS_CAPABILITIES;

  return defineProvider({
    id: "xai",
    name: "xAI (Grok)",
    variant,
    baseUrl: "https://api.x.ai/v1",
    auth: { apiKey: apiKeyFromEnv("xAI API key", ["XAI_API_KEY"]) },
    models: applyCapabilities(XAI_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
