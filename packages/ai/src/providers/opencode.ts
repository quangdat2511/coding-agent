import { stream } from "../api/openai-responses.ts";
import { apiKeyFromEnv } from "../auth/helpers.ts";
import { applyCapabilities, OPENCODE_GO_CHAT_COMPLETIONS_CAPABILITIES } from "../capabilities.ts";
import { PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER } from "../credentials.ts";
import { type BaseProviderOptions, defineProvider, type Provider } from "../models.ts";
import type { ModelCapabilities } from "../types.ts";
import OPENCODE_MODELS from "./opencode.models.json";

/** API variants supported by the OpenCode provider. */
export type OpencodeVariant = "chat_completions";

const OPENCODE_VARIANT_CAPABILITIES: Record<OpencodeVariant, ModelCapabilities> = {
  chat_completions: OPENCODE_GO_CHAT_COMPLETIONS_CAPABILITIES,
};

export interface OpencodeProviderOptions extends BaseProviderOptions<OpencodeVariant> {}

/**
 * OpenCode's Go subscription gateway (ADR 0007), not its pay-as-you-go Zen plan.
 *
 * The base URL is the documented Go root plus its OpenAI path, because the OpenAI SDK appends
 * `/chat/completions` itself. The session id is issued once per provider instance and sent as
 * `x-opencode-session` on every request: Go reuses its prompt cache only while that value stays
 * the same, and one Agent Run streams through one instance. The user agent comes from the
 * caller, which knows its own version.
 */
export function createOpencodeProvider(options?: OpencodeProviderOptions): Provider {
  const variant = options?.variant ?? "chat_completions";
  const defaultCaps = OPENCODE_VARIANT_CAPABILITIES[variant];
  const opencodeSession = crypto.randomUUID();

  return defineProvider({
    id: "opencode",
    name: "OpenCode Go",
    variant,
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    auth: {
      apiKey: apiKeyFromEnv("OpenCode API key", PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER.opencode),
    },
    headers: () => ({ "x-opencode-session": opencodeSession }),
    models: applyCapabilities(OPENCODE_MODELS, defaultCaps, options?.modelOverrides),
    api: { stream },
  });
}
