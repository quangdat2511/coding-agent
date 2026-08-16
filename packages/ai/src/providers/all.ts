import { ModelsImpl, type Provider } from "@/models";
import { googleProvider } from "@/providers/google";
import { openaiProvider } from "@/providers/openai";
import { xaiProvider } from "@/providers/xai";

export function builtinProviders(): Provider[] {
  return [googleProvider(), openaiProvider(), xaiProvider()];
}

export function builtinModels(): ModelsImpl {
  const models = new ModelsImpl();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  return models;
}
