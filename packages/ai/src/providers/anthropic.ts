import { stream } from "@/api/anthropic-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { defineProvider, type Provider } from "@/models";
import ANTHROPIC_MODELS from "@/providers/anthropic.models.json";
import type { Model } from "@/types";

export function createAnthropicProvider(): Provider {
  return defineProvider({
    id: "anthropic",
    name: "Anthropic",
    auth: { apiKey: apiKeyFromEnv("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
    models: ANTHROPIC_MODELS as unknown as Model[],
    api: { stream },
  });
}
