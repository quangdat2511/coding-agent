import { stream } from "../api/google-generate-content.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { applyCapabilities, GOOGLE_GENERATE_CONTENT_CAPABILITIES } from "../capabilities.ts";
import { type BaseProviderOptions, defineProvider, type Provider } from "../models.ts";
import type { ModelCapabilities } from "../types.ts";
import GOOGLE_MODELS from "./google.models.json";

/** API variants supported by the Google provider. */
export type GoogleVariant = "generate_content";

/**
 * Maps each supported API variant to its default capabilities.
 * The `Record` exhaustiveness ensures a new variant entry is required
 * whenever `GoogleVariant` gains a new member (e.g. `"interactions"`).
 */
const GOOGLE_VARIANT_CAPABILITIES: Record<GoogleVariant, ModelCapabilities> = {
  generate_content: GOOGLE_GENERATE_CONTENT_CAPABILITIES,
};

export interface GoogleProviderOptions extends BaseProviderOptions<GoogleVariant> {}

export function createGoogleProvider(options?: GoogleProviderOptions): Provider {
  const variant = options?.variant ?? "generate_content";
  const defaultCaps = GOOGLE_VARIANT_CAPABILITIES[variant];

  return defineProvider({
    id: "google",
    name: "Google (Gemini)",
    variant,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    auth: { apiKey: apiKeyFromEnv("Google API key", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]) },
    models: applyCapabilities(GOOGLE_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
