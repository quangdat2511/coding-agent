// ---------------------------------------------------------------------------
// Provider credential environment variable names
//
// This is the **single source of truth** for the set of environment variable
// names that carry provider credentials. ADR 0001 §8 makes `@coding-agent/ai`
// that source; both `@coding-agent/tools` (for the scrubbed child environment)
// and the composition root read this set.
//
// Only MVP providers are listed. `opencode` keeps its adapter but is not
// among the MVP provider values (ADR 0006 §2), so its variables are excluded.
// ---------------------------------------------------------------------------

/**
 * The environment variable names each MVP provider reads its API credential
 * from, in lookup order: the first one set wins.
 *
 * The composition root and each provider adapter read a provider's credential
 * from these names with `readEnvCredential`, so both pick the same variable.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER = Object.freeze({
  anthropic: Object.freeze(["ANTHROPIC_API_KEY"] as const),
  google: Object.freeze(["GOOGLE_API_KEY", "GEMINI_API_KEY"] as const),
  openai: Object.freeze(["OPENAI_API_KEY"] as const),
  openrouter: Object.freeze(["OPENROUTER_API_KEY"] as const),
  xai: Object.freeze(["XAI_API_KEY"] as const),
});

/**
 * The complete, frozen list of environment variable names that carry
 * provider API credentials for the MVP providers.
 *
 * Consumers that need to strip credentials from a child process environment
 * (ADR 0001 §8 rule 1) should remove exactly these keys and no others.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS = Object.freeze(
  Object.values(PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER).flat(),
);

export type ProviderCredentialEnvVar = (typeof PROVIDER_CREDENTIAL_ENV_VARS)[number];
