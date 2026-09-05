import { stream } from "@/api/openai-responses";
import { envApiKeyAuth } from "@/auth/helpers";
import { createProvider, type Provider } from "@/models";
import GOOGLE_MODELS from "@/providers/google.models.json";
import type { Model } from "@/types";

export function googleProvider(): Provider {
  return createProvider({
    id: "google",
    name: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    auth: { apiKey: envApiKeyAuth("Google API key", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]) },
    models: GOOGLE_MODELS as unknown as Model[],
    api: { stream },
  });
}
