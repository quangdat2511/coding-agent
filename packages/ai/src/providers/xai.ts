import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { XAI_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import XAI_MODELS from "@/providers/xai.models.json";
import type { Model, ModelCapabilities } from "@/types";

function withDefaultCapabilities(
  models: readonly { id: string; name: string; provider: string }[],
  capabilities: ModelCapabilities,
): Model[] {
  return models.map((m) => ({ ...m, capabilities }));
}

export function createXaiProvider(): Provider {
  return defineProvider({
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    auth: { apiKey: apiKeyFromEnv("xAI API key", ["XAI_API_KEY"]) },
    models: withDefaultCapabilities(XAI_MODELS, XAI_CHAT_COMPLETIONS_CAPABILITIES),
    api: { stream },
  });
}
