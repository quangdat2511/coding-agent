import { stream } from "@/api/openai-responses";
import { envApiKeyAuth } from "@/auth/helpers";
import { createProvider, type Provider } from "@/models";
import OPENAI_MODELS from "@/providers/openai.models.json";
import type { Model } from "@/types";

export function openaiProvider(): Provider {
  return createProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: OPENAI_MODELS as unknown as Model[],
    api: { stream },
  });
}
