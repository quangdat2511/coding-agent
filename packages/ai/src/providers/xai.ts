import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { defineProvider, type Provider } from "@/models";
import XAI_MODELS from "@/providers/xai.models.json";
import type { Model } from "@/types";

export function createXaiProvider(): Provider {
  return defineProvider({
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    auth: { apiKey: apiKeyFromEnv("xAI API key", ["XAI_API_KEY"]) },
    models: XAI_MODELS as unknown as Model[],
    api: { stream },
  });
}
