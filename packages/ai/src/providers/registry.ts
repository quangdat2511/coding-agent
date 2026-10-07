import { type Provider, ProviderDirectory } from "#src/models";
import { createAnthropicProvider } from "#src/providers/anthropic";
import { createGoogleProvider } from "#src/providers/google";
import { createOpenAIProvider } from "#src/providers/openai";
import { createOpencodeProvider } from "#src/providers/opencode";
import { createOpenRouterProvider } from "#src/providers/openrouter";
import { createXaiProvider } from "#src/providers/xai";

export function defaultProviders(): Provider[] {
  return [
    createAnthropicProvider(),
    createGoogleProvider(),
    createOpenAIProvider(),
    createOpencodeProvider(),
    createOpenRouterProvider(),
    createXaiProvider(),
  ];
}

export function createProviderDirectory(): ProviderDirectory {
  const directory = new ProviderDirectory();
  for (const provider of defaultProviders()) {
    directory.setProvider(provider);
  }
  return directory;
}
