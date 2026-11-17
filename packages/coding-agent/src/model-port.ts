import type { ModelPort } from "@coding-agent/agent-core";
import { createProviderDirectory, type StreamOptions } from "@coding-agent/ai";
import { BUILD_INFO } from "./build-info.ts";
import type { RunConfig } from "./run-config.ts";

export type ModelPortConfig = Pick<
  RunConfig,
  "model" | "credential" | "sampling" | "transportRetryBound"
>;

export function createModelPort({
  model,
  credential,
  sampling,
  transportRetryBound,
}: ModelPortConfig): ModelPort {
  const { capabilities, ...identity } = model;
  if (capabilities === undefined) {
    throw new Error(`${model.provider} model "${model.id}" declares no Model Capabilities`);
  }
  const directory = createProviderDirectory();
  const settings: StreamOptions = {
    ...(sampling.maxOutputTokens === null ? {} : { maxTokens: sampling.maxOutputTokens }),
    ...(sampling.temperature === null ? {} : { temperature: sampling.temperature }),
    maxRetries: transportRetryBound,
    // The Go gateway asks every client to name itself (ADR 0007 §6). The provider adapters merge
    // these headers over their own, so the caller that knows its version supplies the value.
    headers: { "user-agent": `coding-agent/${BUILD_INFO.version}` },
  };

  return {
    identity,
    capabilities,
    stream: (context, { signal, parallelToolCalls }) =>
      directory.stream(model, context, {
        ...settings,
        apiKey: credential.reveal(),
        signal,
        ...(capabilities.parallelToolCallControl ? { parallelToolCalls } : {}),
      }),
  };
}
