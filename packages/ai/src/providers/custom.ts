import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { stream as anthropicStream } from "../api/anthropic-responses.ts";
import { stream as openaiStream } from "../api/openai-responses.ts";
import type { ProviderCredentials } from "../auth/types.ts";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  withModelOverrides,
} from "../capabilities.ts";
import { defineProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

/**
 * TypeBox schema for a model entry in custom provider configuration.
 */
export const CustomModelConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    capabilities: Type.Optional(
      Type.Partial(
        Type.Object({
          parallelToolCallControl: Type.Boolean(),
          cancellation: Type.Union([
            Type.Literal("client_abort_only"),
            Type.Literal("native_in_flight"),
          ]),
          toolArgumentDelivery: Type.Union([Type.Literal("streamed"), Type.Literal("whole")]),
          usageTiming: Type.Union([Type.Literal("incremental"), Type.Literal("final")]),
          serverSideTools: Type.Boolean(),
        }),
      ),
    ),
  },
  { additionalProperties: false },
);

export type CustomModelConfig = Static<typeof CustomModelConfigSchema>;

/**
 * TypeBox schema for declarative Custom Provider configuration.
 */
export const CustomProviderConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    variant: Type.Union([Type.Literal("chat_completions"), Type.Literal("messages")]),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiKey: Type.Optional(Type.String()),
    apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    models: Type.Array(CustomModelConfigSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type CustomProviderConfig = Static<typeof CustomProviderConfigSchema>;

/**
 * Error thrown when a CustomProviderConfig fails schema validation.
 */
export class CustomProviderValidationError extends Error {
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "CustomProviderValidationError";
    this.errors = errors;
  }
}

/**
 * Creates a standard `Provider` instance from a declarative configuration.
 *
 * - Schema-validated via TypeBox.
 * - Supports wire variants `chat_completions` (OpenAI) and `messages` (Anthropic).
 * - Defaults model capabilities according to the wire variant with per-model overrides.
 * - Supports direct API keys, environment variable resolution, and unauthenticated local runners.
 */
export function createCustomProvider(config: CustomProviderConfig): Provider {
  if (!Value.Check(CustomProviderConfigSchema, config)) {
    const errorList = [...Value.Errors(CustomProviderConfigSchema, config)].map(
      (err) => `${err.instancePath || "#"}: ${err.message}`,
    );
    throw new CustomProviderValidationError(
      `Invalid CustomProviderConfig:\n${errorList.join("\n")}`,
      errorList,
    );
  }

  const normalizedBaseUrl = config.baseUrl?.replace(/\/+$/, "");

  const defaultCaps =
    config.variant === "chat_completions"
      ? OPENAI_CHAT_COMPLETIONS_CAPABILITIES
      : ANTHROPIC_MESSAGES_CAPABILITIES;

  const mappedModels: Model[] = config.models.map((m) => {
    const capabilities = m.capabilities
      ? withModelOverrides(defaultCaps, m.capabilities)
      : defaultCaps;

    return {
      id: m.id,
      name: m.name ?? m.id,
      provider: config.id,
      capabilities,
    };
  });

  const auth: ProviderCredentials = {
    apiKey: {
      name: `${config.id} API key`,
      resolve: async () => {
        if (config.apiKey !== undefined && config.apiKey !== "") {
          return config.apiKey;
        }

        if (config.apiKeyEnv !== undefined && config.apiKeyEnv !== "") {
          return process.env[config.apiKeyEnv];
        }

        // No-auth mode for local unauthenticated runners (Ollama, vLLM, etc.)
        return "no-key";
      },
    },
  };

  const streamAdapter = config.variant === "chat_completions" ? openaiStream : anthropicStream;

  return defineProvider({
    id: config.id,
    name: config.name ?? config.id,
    variant: config.variant,
    baseUrl: normalizedBaseUrl,
    auth,
    headers: config.headers,
    models: mappedModels,
    api: { stream: streamAdapter },
  });
}
