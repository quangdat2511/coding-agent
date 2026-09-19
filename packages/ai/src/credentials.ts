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
 * The complete, frozen list of environment variable names that carry
 * provider API credentials for the MVP providers.
 *
 * Consumers that need to strip credentials from a child process environment
 * (ADR 0001 §8 rule 1) should remove exactly these keys and no others.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
]);
