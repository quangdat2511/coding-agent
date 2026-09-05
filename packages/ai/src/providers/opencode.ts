import { stream } from "@/api/openai-responses";
import { envApiKeyAuth } from "@/auth/helpers";
import { createProvider, type Provider } from "@/models";
import OPENCODE_MODELS from "@/providers/opencode.models.json";
import type { Model } from "@/types";

export function opencodeProvider(): Provider {
  return createProvider({
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
    models: OPENCODE_MODELS as unknown as Model[],
    api: { stream },
  });
}
