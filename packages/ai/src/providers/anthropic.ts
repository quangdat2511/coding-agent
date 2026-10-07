import { stream } from "../api/anthropic-responses.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { ANTHROPIC_MESSAGES_CAPABILITIES, applyCapabilities } from "../capabilities.ts";
import { type BaseProviderOptions, defineProvider, type Provider } from "../models.ts";
import type { ModelCapabilities } from "../types.ts";
import ANTHROPIC_MODELS from "./anthropic.models.json";

/** API variants supported by the Anthropic provider. */
export type AnthropicVariant = "messages";

/**
 * Maps each supported API variant to its default capabilities.
 * The `Record` exhaustiveness ensures a new variant entry is required
 * whenever `AnthropicVariant` gains a new member.
 */
const ANTHROPIC_VARIANT_CAPABILITIES: Record<AnthropicVariant, ModelCapabilities> = {
  messages: ANTHROPIC_MESSAGES_CAPABILITIES,
};

export interface AnthropicProviderOptions extends BaseProviderOptions<AnthropicVariant> {}

export function createAnthropicProvider(options?: AnthropicProviderOptions): Provider {
  const variant = options?.variant ?? "messages";
  const defaultCaps = ANTHROPIC_VARIANT_CAPABILITIES[variant];

  return defineProvider({
    id: "anthropic",
    name: "Anthropic",
    variant,
    auth: { apiKey: apiKeyFromEnv("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
    models: applyCapabilities(ANTHROPIC_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
