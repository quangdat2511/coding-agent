import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { applyCapabilities, XAI_CHAT_COMPLETIONS_CAPABILITIES } from "@/capabilities";
import { type BaseProviderOptions, defineProvider, type Provider } from "@/models";
import XAI_MODELS from "@/providers/xai.models.json";
import type { ModelCapabilities } from "@/types";

/** API variants supported by the xAI provider. */
export type XaiVariant = "chat_completions";

/**
 * Maps each supported API variant to its default capabilities.
 * The `Record` exhaustiveness ensures a new variant entry is required
 * whenever `XaiVariant` gains a new member.
 */
const XAI_VARIANT_CAPABILITIES: Record<XaiVariant, ModelCapabilities> = {
  chat_completions: XAI_CHAT_COMPLETIONS_CAPABILITIES,
};

export interface XaiProviderOptions extends BaseProviderOptions<XaiVariant> {}

export function createXaiProvider(options?: XaiProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = XAI_VARIANT_CAPABILITIES[variant];

  return defineProvider({
    id: "xai",
    name: "xAI (Grok)",
    variant,
    baseUrl: "https://api.x.ai/v1",
    auth: { apiKey: apiKeyFromEnv("xAI API key", ["XAI_API_KEY"]) },
    models: applyCapabilities(XAI_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
