import { type Provider, ProviderDirectory } from "@/models";
import { createAnthropicProvider } from "@/providers/anthropic";
import { createGoogleProvider } from "@/providers/google";
import { createOpenAIProvider } from "@/providers/openai";
import { createOpencodeProvider } from "@/providers/opencode";
import { createOpenRouterProvider } from "@/providers/openrouter";
import { createXaiProvider } from "@/providers/xai";

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
