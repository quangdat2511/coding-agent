import { stream } from "#src/api/openai-responses";
import { apiKeyFromEnv } from "#src/auth/helpers";
import { applyCapabilities, OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES } from "#src/capabilities";
import { type BaseProviderOptions, defineProvider, type Provider } from "#src/models";
import OPENROUTER_MODELS from "#src/providers/openrouter.models.json";
import type { ModelCapabilities } from "#src/types";

/** API variants supported by the OpenRouter provider. */
export type OpenRouterVariant = "chat_completions";

/**
 * Maps each supported API variant to its default capabilities.
 * The `Record` exhaustiveness ensures a new variant entry is required
 * whenever `OpenRouterVariant` gains a new member.
 */
const OPENROUTER_VARIANT_CAPABILITIES: Record<OpenRouterVariant, ModelCapabilities> = {
  chat_completions: OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
};

export interface OpenRouterProviderOptions extends BaseProviderOptions<OpenRouterVariant> {}

export function createOpenRouterProvider(options?: OpenRouterProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = OPENROUTER_VARIANT_CAPABILITIES[variant];

  return defineProvider({
    id: "openrouter",
    name: "OpenRouter",
    variant,
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { apiKey: apiKeyFromEnv("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
    headers: {
      "HTTP-Referer": "https://github.com/quangdat2511/coding-agent",
      "X-Title": "Coding Agent",
    },
    models: applyCapabilities(OPENROUTER_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
