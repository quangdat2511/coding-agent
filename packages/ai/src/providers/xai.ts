import { stream } from "@/api/openai-responses";
import { envApiKeyAuth } from "@/auth/helpers";
import { createProvider, type Provider } from "@/models";
import XAI_MODELS from "@/providers/xai.models.json";
import type { Model } from "@/types";

export function xaiProvider(): Provider {
  return createProvider({
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    auth: { apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]) },
    models: XAI_MODELS as unknown as Model[],
    api: { stream },
  });
}
