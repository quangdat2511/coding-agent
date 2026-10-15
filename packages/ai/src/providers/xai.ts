import { stream } from "../api/openai-responses.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { applyCapabilities, XAI_CHAT_COMPLETIONS_CAPABILITIES } from "../capabilities.ts";
import { PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER } from "../credentials.ts";
import { type BaseProviderOptions, defineProvider, type Provider } from "../models.ts";
import type { ModelCapabilities } from "../types.ts";
import XAI_MODELS from "./xai.models.json";

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
    auth: { apiKey: apiKeyFromEnv("xAI API key", PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER.xai) },
    models: applyCapabilities(XAI_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
