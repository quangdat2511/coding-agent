import type { ModelPort } from "@coding-agent/agent-core";
import type { Model, ProviderDirectory, StreamOptions } from "@coding-agent/ai";

// An empty object leaves every setting to the Model Provider's default.
export type SamplingSettings = Readonly<Pick<StreamOptions, "temperature" | "maxTokens">>;

export interface ModelSettings {
  readonly sampling: SamplingSettings;
  readonly transportRetryBound: number;
}

export interface ModelPortConfig {
  // The directory the model was resolved from, so the catalog is built once per run.
  readonly providers: ProviderDirectory;
  readonly model: Model;
  // A ResolvedCredential: the value is read only when a request goes out.
  readonly credential: { reveal(): string };
  readonly settings: ModelSettings;
}

// Agent Core's only way to reach a model. The settings are bound here, so Agent Core never reads
// them, and every difference between providers is read from the declared capabilities, never from
// the provider's identity.
export function createModelPort({
  providers,
  model,
  credential,
  settings,
}: ModelPortConfig): ModelPort {
  const { id, name, provider: providerId, capabilities } = model;
  if (capabilities === undefined) {
    throw new Error(`${providerId} model "${id}" declares no capabilities`);
  }
  const provider = providers.getProvider(providerId);
  if (provider === undefined) throw new Error(`no Model Provider is registered as "${providerId}"`);

  return {
    identity: { id, name, provider: providerId },
    capabilities,
    stream(context, { signal, parallelToolCalls }) {
      return provider.stream(model, context, {
        ...settings.sampling,
        apiKey: credential.reveal(),
        maxRetries: settings.transportRetryBound,
        signal,
        // Agent Core always asks; an API that cannot honour the request never receives it.
        ...(capabilities.parallelToolCallControl ? { parallelToolCalls } : {}),
      });
    },
  };
}
