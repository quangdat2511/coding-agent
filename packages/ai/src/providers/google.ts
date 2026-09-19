import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { GOOGLE_GENERATE_CONTENT_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import GOOGLE_MODELS from "@/providers/google.models.json";
import type { Model, ModelCapabilities } from "@/types";

function withDefaultCapabilities(
  models: readonly { id: string; name: string; provider: string }[],
  capabilities: ModelCapabilities,
): Model[] {
  return models.map((m) => ({ ...m, capabilities }));
}

export function createGoogleProvider(): Provider {
  return defineProvider({
    id: "google",
    name: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    auth: { apiKey: apiKeyFromEnv("Google API key", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]) },
    models: withDefaultCapabilities(GOOGLE_MODELS, GOOGLE_GENERATE_CONTENT_CAPABILITIES),
    api: { stream },
  });
}
