import { stream } from "@/api/anthropic-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { ANTHROPIC_MESSAGES_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import ANTHROPIC_MODELS from "@/providers/anthropic.models.json";
import type { Model, ModelCapabilities } from "@/types";

function withDefaultCapabilities(
  models: readonly { id: string; name: string; provider: string }[],
  capabilities: ModelCapabilities,
): Model[] {
  return models.map((m) => ({ ...m, capabilities }));
}

export function createAnthropicProvider(): Provider {
  return defineProvider({
    id: "anthropic",
    name: "Anthropic",
    auth: { apiKey: apiKeyFromEnv("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
    models: withDefaultCapabilities(ANTHROPIC_MODELS, ANTHROPIC_MESSAGES_CAPABILITIES),
    api: { stream },
  });
}
