import { stream } from "../api/openai-responses.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { applyCapabilities, OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES } from "../capabilities.ts";
import { PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER } from "../credentials.ts";
import { type BaseProviderOptions, defineProvider, type Provider } from "../models.ts";
import type { ModelCapabilities } from "../types.ts";
import OPENROUTER_MODELS from "./openrouter.models.json";

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
    auth: {
      apiKey: apiKeyFromEnv(
        "OpenRouter API key",
        PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER.openrouter,
      ),
    },
    headers: {
      "HTTP-Referer": "https://github.com/quangdat2511/coding-agent",
      "X-Title": "Coding Agent",
    },
    models: applyCapabilities(OPENROUTER_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
