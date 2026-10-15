import type { ApiKeySource } from "./types.ts";

/** A credential found in the environment: the variable that held it and its trimmed value. */
export interface EnvCredential<V extends string = string> {
  readonly variable: V;
  readonly value: string;
}

/**
 * Finds the first of `envVars` that holds a credential. Values are trimmed, and a blank one counts
 * as unset, so the lookup moves on to the next name.
 *
 * Provider adapters and the composition root both read credentials through this function, so they
 * always agree on which variable holds a provider's key.
 */
export function readEnvCredential<V extends string>(
  envVars: readonly V[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvCredential<V> | undefined {
  for (const variable of envVars) {
    const value = env[variable]?.trim();
    if (value) return { variable, value };
  }
  return undefined;
}

export function apiKeyFromEnv(name: string, envVars: readonly string[]): ApiKeySource {
  return {
    name,
    resolve: async () => readEnvCredential(envVars)?.value,
  };
}
