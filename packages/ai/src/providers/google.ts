import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { defineProvider, type Provider } from "@/models";
import GOOGLE_MODELS from "@/providers/google.models.json";
import type { Model } from "@/types";

export function createGoogleProvider(): Provider {
  return defineProvider({
    id: "google",
    name: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    auth: { apiKey: apiKeyFromEnv("Google API key", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]) },
    models: GOOGLE_MODELS as unknown as Model[],
    api: { stream },
  });
}
