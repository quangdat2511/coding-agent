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
const LOCAL_RUNNER_NO_AUTH_KEY = "no-key";

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
    id: Type.String({ minLength: 1, pattern: "^\\S(?:.*\\S)?$" }),
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
    id: Type.String({ minLength: 1, pattern: "^\\S(?:.*\\S)?$" }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    variant: Type.Union([Type.Literal("chat_completions"), Type.Literal("messages")]),
    baseUrl: Type.Optional(Type.String({ minLength: 1, pattern: "^\\S(?:.*\\S)?$" })),
    apiKey: Type.Optional(Type.String({ minLength: 1, pattern: "^\\S(?:.*\\S)?$" })),
    apiKeyEnv: Type.Optional(Type.String({ minLength: 1, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    models: Type.Array(CustomModelConfigSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type CustomProviderConfig = Static<typeof CustomProviderConfigSchema>;

export class CustomProviderValidationError extends Error {
  readonly code = "INVALID_CUSTOM_PROVIDER_CONFIG" as const;
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "CustomProviderValidationError";
    this.errors = errors;
  }
}

function formatValidationErrors(
  errors: Iterable<{ instancePath: string; message: string }>,
): string[] {
  return [...errors].map((err) => `${err.instancePath || "#"}: ${err.message}`);
}

/** Creates a standard Provider instance from a declarative configuration. */
export function createCustomProvider(config: CustomProviderConfig): Provider {
  if (!Value.Check(CustomProviderConfigSchema, config)) {
    const errorList = formatValidationErrors(Value.Errors(CustomProviderConfigSchema, config));
    throw new CustomProviderValidationError(
      `Invalid CustomProviderConfig:\n${errorList.join("\n")}`,
      errorList,
    );
  }

  // Edge case validation: explicit whitespace-only check
  const explicitKey = config.apiKey?.trim();
  if (config.apiKey !== undefined && explicitKey === "") {
    throw new CustomProviderValidationError("apiKey must not be empty or whitespace-only", [
      "#/apiKey: Expected non-whitespace string",
    ]);
  }

  const explicitKeyEnv = config.apiKeyEnv?.trim();
  if (config.apiKeyEnv !== undefined && explicitKeyEnv === "") {
    throw new CustomProviderValidationError("apiKeyEnv must not be empty or whitespace-only", [
      "#/apiKeyEnv: Expected non-whitespace string",
    ]);
  }

  // Unauthenticated local runner requires baseUrl
  const isNoAuth = explicitKey === undefined && explicitKeyEnv === undefined;
  if (isNoAuth && (!config.baseUrl || config.baseUrl.trim() === "")) {
    throw new CustomProviderValidationError(
      "Custom provider without apiKey or apiKeyEnv requires baseUrl for local unauthenticated endpoint (e.g. http://localhost:11434/v1)",
      ["#/baseUrl: baseUrl is required when no authentication is configured"],
    );
  }

  const normalizedBaseUrl = config.baseUrl?.replace(/\/+$/, "");
  const variantDefinition = CUSTOM_VARIANT_DEFINITIONS[config.variant];

  const mappedModels: readonly Model[] = config.models.map((modelConfig) => {
    const capabilities = modelConfig.capabilities
      ? withModelOverrides(variantDefinition.defaultCapabilities, modelConfig.capabilities)
      : variantDefinition.defaultCapabilities;

    return {
      id: modelConfig.id,
      name: modelConfig.name ?? modelConfig.id,
      provider: config.id,
      capabilities,
    };
  });

  const auth: ProviderCredentials = {
    apiKey: {
      name: `${config.id} API key`,
      resolve: async () => {
        if (explicitKey !== undefined && explicitKey !== "") {
          return explicitKey;
        }

        if (explicitKeyEnv !== undefined && explicitKeyEnv !== "") {
          return readEnvCredential([explicitKeyEnv])?.value;
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
