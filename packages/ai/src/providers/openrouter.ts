import { stream } from "@/api/openai-responses";
import { envApiKeyAuth } from "@/auth/helpers";
import { createProvider, type Provider } from "@/models";
import OPENROUTER_MODELS from "@/providers/openrouter.models.json";
import type { Model } from "@/types";

export function openrouterProvider(): Provider {
  return createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
    models: OPENROUTER_MODELS as unknown as Model[],
    api: { stream },
  });
}
