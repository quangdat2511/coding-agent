import { stream } from "@/api/anthropic-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { ANTHROPIC_MESSAGES_CAPABILITIES, applyCapabilities } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import ANTHROPIC_MODELS from "@/providers/anthropic.models.json";
import type { ModelCapabilities } from "@/types";

export interface AnthropicProviderOptions {
  variant?: "messages";
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export function createAnthropicProvider(options?: AnthropicProviderOptions): Provider {
  const variant = options?.variant ?? "messages";
  const defaultCaps = ANTHROPIC_MESSAGES_CAPABILITIES;

  return defineProvider({
    id: "anthropic",
    name: "Anthropic",
    variant,
    auth: { apiKey: apiKeyFromEnv("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
    models: applyCapabilities(ANTHROPIC_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
