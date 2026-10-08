import { type Provider, ProviderDirectory } from "../models.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createGoogleProvider } from "./google.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createOpencodeProvider } from "./opencode.ts";
import { createOpenRouterProvider } from "./openrouter.ts";
import { createXaiProvider } from "./xai.ts";

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
