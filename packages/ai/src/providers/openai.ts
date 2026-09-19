import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { OPENAI_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import OPENAI_MODELS from "@/providers/openai.models.json";
import type { Model, ModelCapabilities } from "@/types";

function withDefaultCapabilities(
  models: readonly { id: string; name: string; provider: string }[],
  capabilities: ModelCapabilities,
): Model[] {
  return models.map((m) => ({ ...m, capabilities }));
}

export function createOpenAIProvider(): Provider {
  return defineProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: apiKeyFromEnv("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: withDefaultCapabilities(OPENAI_MODELS, OPENAI_CHAT_COMPLETIONS_CAPABILITIES),
    api: { stream },
  });
}
