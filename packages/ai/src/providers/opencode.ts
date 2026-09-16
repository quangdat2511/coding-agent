import { stream } from "@/api/openai-responses";
import { apiKeyFromEnv } from "@/auth/helpers";
import { defineProvider, type Provider } from "@/models";
import OPENCODE_MODELS from "@/providers/opencode.models.json";
import type { Model } from "@/types";

export function createOpencodeProvider(): Provider {
  return defineProvider({
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    auth: { apiKey: apiKeyFromEnv("OpenCode API key", ["OPENCODE_API_KEY"]) },
    headers: () => ({
      "x-session-id": process.env.OPENCODE_SESSION_ID || crypto.randomUUID(),
    }),
    models: OPENCODE_MODELS as unknown as Model[],
    api: { stream },
  });
}
