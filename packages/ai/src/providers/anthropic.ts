import { stream } from "@/api/anthropic-responses";
import { envApiKeyAuth } from "@/auth/helpers";
import { createProvider, type Provider } from "@/models";
import ANTHROPIC_MODELS from "@/providers/anthropic.models.json";
import type { Model } from "@/types";

export function anthropicProvider(): Provider {
  return createProvider({
    id: "anthropic",
    name: "Anthropic",
    auth: { apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
    models: ANTHROPIC_MODELS as unknown as Model[],
    api: { stream },
  });
}
