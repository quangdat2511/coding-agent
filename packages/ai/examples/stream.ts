import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Context, Model, ModelsImpl } from "@/index";
import { builtinModels } from "@/providers/all";

export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (key) {
      result[key] = val;
    }
  }
  return result;
}

export function loadRootEnv(startDir = import.meta.dir): string | undefined {
  let currentDir = startDir;
  while (currentDir !== dirname(currentDir)) {
    const envPath = resolve(currentDir, ".env");
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, "utf-8");
        const parsed = parseEnv(content);
        for (const [key, val] of Object.entries(parsed)) {
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
        return envPath;
      } catch {
        // Ignore read errors
        return undefined;
      }
    }
    currentDir = dirname(currentDir);
  }
  return undefined;
}

// Load root .env before resolving providers
loadRootEnv();

export const DEFAULT_MODELS: Record<string, string> = {
  google: "gemini-3.6-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  openrouter: "openai/gpt-4o",
  xai: "grok-beta",
};

const DEFAULT_PROMPT =
  "Hãy viết đoạn văn ngắn giới thiệu về trường Đại học Khoa học Tự nhiên (HCMUS).";

function printHelp(): void {
  const providerList = Object.keys(DEFAULT_MODELS).join(", ");
  console.log(`
Usage:
  bun run example [provider] [model] [prompt]

Arguments:
  provider    LLM provider (${providerList})
  model       Model identifier (e.g. gemini-3.6-flash, gpt-4o, claude-sonnet-4-5)
  prompt      Prompt text sent to the model

Examples:
  bun run example
  bun run example google gemini-3.6-flash "Tóm tắt ưu điểm của TypeScript"
  bun run example openai gpt-4o "Explain monorepo architecture"
`);
}

export async function resolveProviderAndModel(
  models: ModelsImpl,
  argProvider?: string,
  argModel?: string,
): Promise<{ model: Model; providerId: string }> {
  let providerId = argProvider;
  let modelId = argModel;

  if (providerId) {
    const provider = models.getProvider(providerId);
    if (!provider) {
      const validProviders = Object.keys(DEFAULT_MODELS).join(", ");
      throw new Error(
        `Provider '${providerId}' is not registered. Available providers: ${validProviders}.`,
      );
    }
  } else {
    // Auto-detect first provider with an active API key
    for (const candidateId of Object.keys(DEFAULT_MODELS)) {
      const p = models.getProvider(candidateId);
      if (p) {
        const apiKey = await p.auth.apiKey?.resolve();
        if (apiKey) {
          providerId = candidateId;
          modelId = DEFAULT_MODELS[candidateId];
          break;
        }
      }
    }

    // Default to google if no keys detected
    if (!providerId) {
      providerId = "google";
      modelId = DEFAULT_MODELS.google;
    }
  }

  if (!modelId && providerId) {
    modelId = DEFAULT_MODELS[providerId] ?? models.getProvider(providerId)?.getModels()[0]?.id;
  }

  if (!modelId) {
    throw new Error(`Could not determine default model for provider '${providerId}'.`);
  }

  const model = models.getModel(providerId, modelId);
  if (!model) {
    throw new Error(`Model '${modelId}' not found in provider '${providerId}'.`);
  }

  return { model, providerId };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const [argProvider, argModel, ...promptParts] = args;
  const prompt = promptParts.length > 0 ? promptParts.join(" ") : DEFAULT_PROMPT;

  const models = builtinModels();
  const { model, providerId } = await resolveProviderAndModel(models, argProvider, argModel);
  const provider = models.getProvider(providerId);

  // Check credentials
  const apiKey = await provider?.auth.apiKey?.resolve();
  if (!apiKey) {
    console.warn(
      `\n⚠️  [Warning] No API key detected for provider '${providerId}'. The request may fail.`,
    );
    console.warn(`   Please ensure required environment variables are configured in .env.\n`);
  }

  const context: Context = {
    systemPrompt: "You are a helpful and concise coding assistant.",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  console.log("==================================================");
  console.log(`🤖 Provider : ${providerId}`);
  console.log(`📦 Model    : ${model.id} (${model.name})`);
  console.log(`💬 Prompt   : "${prompt}"`);
  console.log("==================================================\n");

  const startTime = Date.now();
  const eventStream = models.stream(model, context, { maxTokens: 2000 });

  let textReceived = false;

  for await (const event of eventStream) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.delta);
        textReceived = true;
        break;
      case "error":
        console.error(`\n❌ [Stream Error]: ${event.error.errorMessage}`);
        break;
    }
  }

  const finalMessage = await eventStream.result();
  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

  if (finalMessage.stopReason === "error") {
    if (!textReceived) {
      console.error(`\n❌ Failed with error: ${finalMessage.errorMessage ?? "Unknown error"}`);
    } else {
      console.error(
        `\n\n❌ Stream interrupted with error: ${finalMessage.errorMessage ?? "Unknown error"}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("\n\n--------------------------------------------------");
  console.log(`✨ Finished in ${elapsedSeconds}s | Stop Reason: ${finalMessage.stopReason}`);
  console.log("--------------------------------------------------");
}

if (import.meta.main) {
  process.on("SIGINT", () => {
    console.log("\nAborted by user.");
    process.exit(0);
  });

  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Fatal error: ${message}`);
    process.exit(1);
  });
}
