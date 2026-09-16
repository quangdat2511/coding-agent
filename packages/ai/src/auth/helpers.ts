import type { ApiKeySource } from "@/auth/types";

export function apiKeyFromEnv(name: string, envVars: readonly string[]): ApiKeySource {
  return {
    name,
    resolve: async () => {
      for (const envVar of envVars) {
        if (process.env[envVar]) {
          return process.env[envVar];
        }
      }
      return undefined;
    },
  };
}
