import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { defineProvider, type Provider } from "@/models";
import OPENAI_MODELS from "@/providers/openai.models.json";
import type { Model } from "@/types";

export function createOpenAIProvider(): Provider {
  return defineProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: apiKeyFromEnv("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: OPENAI_MODELS as unknown as Model[],
    api: { stream },
  });
}
