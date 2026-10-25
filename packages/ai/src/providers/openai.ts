import { stream } from "../api/openai-responses.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { applyCapabilities, OPENAI_CHAT_COMPLETIONS_CAPABILITIES } from "../capabilities.ts";
import { PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER } from "../credentials.ts";
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

/**
 * The o-series reasoning models answer `parallel_tool_calls` with 400 "Unsupported parameter", so
 * they declare no parallel Tool Call control and never receive it.
 */
export const OPENAI_MODEL_OVERRIDES: Readonly<Record<string, Partial<ModelCapabilities>>> =
  Object.freeze(
    Object.fromEntries(
      ["o1", "o1-pro", "o3", "o3-mini", "o3-pro", "o4-mini"].map((id) => [
        id,
        { parallelToolCallControl: false },
      ]),
    ),
  );

export interface OpenAIProviderOptions extends BaseProviderOptions<OpenAIVariant> {}

export function createOpenAIProvider(options?: OpenAIProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = OPENAI_VARIANT_CAPABILITIES[variant];

  return defineProvider({
    id: "openai",
    name: "OpenAI",
    variant,
    baseUrl: "https://api.openai.com/v1",
    auth: {
      apiKey: apiKeyFromEnv("OpenAI API key", PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER.openai),
    },
    models: applyCapabilities(OPENAI_MODELS, defaultCaps, {
      ...OPENAI_MODEL_OVERRIDES,
      ...options?.modelOverrides,
    }),
    api: { stream },
  });
}
