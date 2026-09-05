import type { ApiKeyAuth } from "@/auth/types";

export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
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
