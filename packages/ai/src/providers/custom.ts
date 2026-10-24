import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { stream as anthropicStream } from "../api/anthropic-responses.ts";
import { stream as openaiStream } from "../api/openai-responses.ts";
import { readEnvCredential } from "../auth/helpers.ts";
import type { ProviderCredentials } from "../auth/types.ts";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  withModelOverrides,
} from "../capabilities.ts";
import { defineProvider, type Provider, type ProviderApi } from "../models.ts";
import type { Model, ModelCapabilities } from "../types.ts";

/** Fallback credential for unauthenticated local endpoints (Ollama, vLLM). */
export const LOCAL_RUNNER_NO_AUTH_KEY = "no-key";

export type CustomProviderVariant = "chat_completions" | "messages";

interface CustomVariantDefinition {
  readonly defaultCapabilities: ModelCapabilities;
  readonly stream: ProviderApi["stream"];
}

const CUSTOM_VARIANT_DEFINITIONS: Record<CustomProviderVariant, CustomVariantDefinition> = {
  chat_completions: {
    defaultCapabilities: OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
    stream: openaiStream,
  },
  messages: {
    defaultCapabilities: ANTHROPIC_MESSAGES_CAPABILITIES,
    stream: anthropicStream,
  },
};

export const CustomModelConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    capabilities: Type.Optional(
      Type.Partial(
        Type.Object(
          {
            parallelToolCallControl: Type.Boolean(),
            cancellation: Type.Union([
              Type.Literal("client_abort_only"),
              Type.Literal("native_in_flight"),
            ]),
            toolArgumentDelivery: Type.Union([Type.Literal("streamed"), Type.Literal("whole")]),
            usageTiming: Type.Union([Type.Literal("incremental"), Type.Literal("final")]),
            serverSideTools: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type CustomModelConfig = Static<typeof CustomModelConfigSchema>;

export const CustomProviderConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    variant: Type.Union([Type.Literal("chat_completions"), Type.Literal("messages")]),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiKey: Type.Optional(Type.String({ minLength: 1 })),
    apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    models: Type.Array(CustomModelConfigSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type CustomProviderConfig = Static<typeof CustomProviderConfigSchema>;

export class CustomProviderValidationError extends Error {
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "CustomProviderValidationError";
    this.errors = errors;
  }
}

/** Creates a standard Provider instance from a declarative configuration. */
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
  const variantDefinition = CUSTOM_VARIANT_DEFINITIONS[config.variant];

  const mappedModels: readonly Model[] = Object.freeze(
    config.models.map((modelConfig) => {
      const capabilities = modelConfig.capabilities
        ? withModelOverrides(variantDefinition.defaultCapabilities, modelConfig.capabilities)
        : variantDefinition.defaultCapabilities;

      return Object.freeze({
        id: modelConfig.id,
        name: modelConfig.name ?? modelConfig.id,
        provider: config.id,
        capabilities,
      });
    }),
  );

  const auth: ProviderCredentials = {
    apiKey: {
      name: `${config.id} API key`,
      resolve: async () => {
        const explicitKey = config.apiKey?.trim();
        if (explicitKey !== undefined && explicitKey !== "") {
          return explicitKey;
        }

        if (config.apiKeyEnv !== undefined && config.apiKeyEnv !== "") {
          return readEnvCredential([config.apiKeyEnv])?.value;
        }

        return LOCAL_RUNNER_NO_AUTH_KEY;
      },
    },
  };

  return defineProvider({
    id: config.id,
    name: config.name ?? config.id,
    variant: config.variant,
    baseUrl: normalizedBaseUrl,
    auth,
    headers: config.headers,
    models: mappedModels,
    api: { stream: variantDefinition.stream },
  });
}
