import type { ProviderAuth } from "@/auth/types";
import type { Context, Model, StreamOptions } from "@/types";
import type { AssistantMessageEventStream } from "@/utils/event-stream";

export interface Provider {
  id: string;
  name: string;
  baseUrl?: string;
  auth: ProviderAuth;
  getModels(): readonly Model[];
  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream;
}

export interface ProviderStreams {
  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream;
}

export interface CreateProviderOptions {
  id: string;
  name?: string;
  baseUrl?: string;
  auth: ProviderAuth;
  models: readonly Model[];
  api: ProviderStreams;
}

export function createProvider(input: CreateProviderOptions): Provider {
  return {
    id: input.id,
    name: input.name ?? input.id,
    baseUrl: input.baseUrl,
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, context, options) => {
      const apiKey = options?.apiKey ?? input.auth.apiKey?.resolve();
      const mergedOptions = {
        ...options,
        apiKey,
        baseURL: options?.baseURL ?? input.baseUrl,
      };

      return input.api.stream(model, context, mergedOptions);
    },
  };
}

export class ModelsImpl {
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

  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream {
    const provider = this.getProvider(model.provider);
    if (!provider) {
      throw new Error(`Provider ${model.provider} not found`);
    }

    return provider.stream(model, context, options);
  }
}
