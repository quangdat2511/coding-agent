import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Provider, ProviderDirectory } from "../models.ts";
import {
  type CustomProviderConfig,
  CustomProviderConfigSchema,
  CustomProviderValidationError,
  createCustomProvider,
} from "./custom.ts";

export const CustomProvidersArraySchema = Type.Array(CustomProviderConfigSchema);

export const CustomProviderMapEntrySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    variant: Type.Union([Type.Literal("chat_completions"), Type.Literal("messages")]),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiKey: Type.Optional(Type.String({ minLength: 1 })),
    apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    models: CustomProviderConfigSchema.properties.models,
  },
  { additionalProperties: false },
);

export const CustomProvidersMapSchema = Type.Object(
  {
    providers: Type.Record(Type.String({ minLength: 1 }), CustomProviderMapEntrySchema),
  },
  { additionalProperties: false },
);

/**
 * Parses raw JSON string into a validated array of CustomProviderConfig objects.
 * Supports both an array format and an object map format ({ providers: { [id]: config } }).
 */
export function parseCustomProviderConfigs(rawContent: string): CustomProviderConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new CustomProviderValidationError(
      `Failed to parse custom providers JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Format 1: Direct array of CustomProviderConfig
  if (Array.isArray(parsed)) {
    if (!Value.Check(CustomProvidersArraySchema, parsed)) {
      const errorList = [...Value.Errors(CustomProvidersArraySchema, parsed)].map(
        (err) => `${err.instancePath || "#"}: ${err.message}`,
      );
      throw new CustomProviderValidationError(
        `Invalid custom providers array config:\n${errorList.join("\n")}`,
        errorList,
      );
    }
    return parsed;
  }

  // Format 2: Object with providers map { providers: { [id]: config } }
  if (Value.Check(CustomProvidersMapSchema, parsed)) {
    const result: CustomProviderConfig[] = [];
    for (const [providerId, entry] of Object.entries(parsed.providers)) {
      result.push({
        id: providerId,
        ...entry,
      });
    }
    return result;
  }

  // If neither format matches, throw validation error
  const errors = [...Value.Errors(CustomProvidersArraySchema, parsed)].map(
    (err) => `${err.instancePath || "#"}: ${err.message}`,
  );
  throw new CustomProviderValidationError(
    `Invalid custom providers configuration format. Expected array or { providers: { [id]: ... } }.\n${errors.join("\n")}`,
    errors,
  );
}

/**
 * Reads and instantiates custom providers from a JSON file.
 * Returns an empty array if the file does not exist.
 */
export function loadCustomProvidersFromFile(filePath: string): Provider[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf-8");
  const configs = parseCustomProviderConfigs(content);
  return configs.map((config) => createCustomProvider(config));
}

/**
 * Loads custom providers from a JSON file and registers them into the given ProviderDirectory.
 * Returns the registered Provider instances.
 */
export function registerCustomProvidersFromFile(
  directory: ProviderDirectory,
  filePath: string,
): Provider[] {
  const providers = loadCustomProvidersFromFile(filePath);
  for (const provider of providers) {
    directory.setProvider(provider);
  }
  return providers;
}
