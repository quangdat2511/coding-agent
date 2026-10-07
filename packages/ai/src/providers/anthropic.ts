import { stream } from "#src/api/anthropic-responses";
import { apiKeyFromEnv } from "#src/auth/helpers";
import { ANTHROPIC_MESSAGES_CAPABILITIES, applyCapabilities } from "#src/capabilities";
import { type BaseProviderOptions, defineProvider, type Provider } from "#src/models";
import ANTHROPIC_MODELS from "#src/providers/anthropic.models.json";
import type { ModelCapabilities } from "#src/types";

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
