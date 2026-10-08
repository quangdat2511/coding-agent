import { stream } from "../api/openai-responses.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { applyCapabilities, OPENAI_CHAT_COMPLETIONS_CAPABILITIES } from "../capabilities.ts";
import { type BaseProviderOptions, defineProvider, type Provider } from "../models.ts";
import type { ModelCapabilities } from "../types.ts";
import OPENAI_MODELS from "./openai.models.json";

/** API variants supported by the OpenAI provider. */
export type OpenAIVariant = "chat_completions";

/**
 * Maps each supported API variant to its default capabilities.
 * The `Record` exhaustiveness ensures a new variant entry is required
 * whenever `OpenAIVariant` gains a new member.
 */
const OPENAI_VARIANT_CAPABILITIES: Record<OpenAIVariant, ModelCapabilities> = {
  chat_completions: OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
};

export interface OpenAIProviderOptions extends BaseProviderOptions<OpenAIVariant> {}

export function createOpenAIProvider(options?: OpenAIProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = OPENAI_VARIANT_CAPABILITIES[variant];

  return defineProvider({
    id: "openai",
    name: "OpenAI",
    variant,
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: apiKeyFromEnv("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: applyCapabilities(OPENAI_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
