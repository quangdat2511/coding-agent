import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { applyCapabilities, GOOGLE_GENERATE_CONTENT_CAPABILITIES } from "@/capabilities";
import { defineProvider, type Provider } from "@/models";
import GOOGLE_MODELS from "@/providers/google.models.json";
import type { ModelCapabilities } from "@/types";

export interface GoogleProviderOptions {
  variant?: "generate_content";
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export function createGoogleProvider(options?: GoogleProviderOptions): Provider {
  const variant = options?.variant ?? "generate_content";
  const defaultCaps = GOOGLE_GENERATE_CONTENT_CAPABILITIES;

  return defineProvider({
    id: "google",
    name: "Google (Gemini)",
    variant,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    auth: { apiKey: apiKeyFromEnv("Google API key", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]) },
    models: applyCapabilities(GOOGLE_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
