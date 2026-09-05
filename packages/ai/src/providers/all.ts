import { ModelsImpl, type Provider } from "@/models";
import { anthropicProvider } from "@/providers/anthropic";
import { googleProvider } from "@/providers/google";
import { openaiProvider } from "@/providers/openai";
import { openrouterProvider } from "@/providers/openrouter";
import { xaiProvider } from "@/providers/xai";

export function builtinProviders(): Provider[] {
  return [
    anthropicProvider(),
    googleProvider(),
    openaiProvider(),
    openrouterProvider(),
    xaiProvider(),
  ];
}

export function builtinModels(): ModelsImpl {
  const models = new ModelsImpl();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  return models;
}
