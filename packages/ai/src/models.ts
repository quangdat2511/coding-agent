import type { ProviderCredentials } from "./auth/types.ts";
import type {
  ApiVariant,
  Context,
  Model,
  ModelCapabilities,
  ModelStream,
  StreamOptions,
} from "./types.ts";

/**
 * Shared base for all provider-specific options interfaces.
 *
 * `V` constrains which API-variant literals are valid for a given provider.
 * Provider-specific interfaces extend this with the appropriate variant
 * literal (e.g. `BaseProviderOptions<"messages">` for Anthropic), so callers
 * get a compile-time error if they pass an unsupported variant.
 */
export interface BaseProviderOptions<V extends ApiVariant = ApiVariant> {
  variant?: V;
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export interface Provider {
  id: string;
  name: string;
  variant?: ApiVariant;
  baseUrl?: string;
  auth: ProviderCredentials;
  headers?: Record<string, string> | (() => Record<string, string>);
  getModels(): readonly Model[];
  stream(model: Model, context: Context, options?: StreamOptions): ModelStream;
}

export interface ProviderApi {
  stream(model: Model, context: Context, options?: StreamOptions): ModelStream;
}

export interface ProviderOptions {
  id: string;
  name?: string;
  variant?: ApiVariant;
  baseUrl?: string;
  auth: ProviderCredentials;
  models: readonly Model[];
  api: ProviderApi;
  headers?: Record<string, string> | (() => Record<string, string>);
}

export function defineProvider(input: ProviderOptions): Provider {
  return {
    id: input.id,
    name: input.name ?? input.id,
    variant: input.variant,
    baseUrl: input.baseUrl,
    auth: input.auth,
    headers: input.headers,
    getModels: () => input.models,
    stream: (model, context, options) => {
      const apiKey = options?.apiKey ?? input.auth.apiKey?.resolve();
      const providerHeaders = typeof input.headers === "function" ? input.headers() : input.headers;
      const mergedHeaders =
        providerHeaders || options?.headers
          ? {
              ...providerHeaders,
              ...options?.headers,
            }
          : undefined;

      const mergedOptions: StreamOptions = {
        ...options,
        apiKey,
        baseURL: options?.baseURL ?? input.baseUrl,
        headers: mergedHeaders,
      };

      return input.api.stream(model, context, mergedOptions);
    },
  };
}

export class ProviderDirectory {
  private providers = new Map<string, Provider>();

  setProvider(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  getModel(providerId: string, modelId: string): Model | undefined {
    const provider = this.getProvider(providerId);
    if (!provider) return undefined;

    return provider.getModels().find((m) => m.id === modelId);
  }

  stream(model: Model, context: Context, options?: StreamOptions): ModelStream {
    const provider = this.getProvider(model.provider);
    if (!provider) {
      throw new Error(`Provider ${model.provider} not found`);
    }

    return provider.stream(model, context, options);
  }
}
