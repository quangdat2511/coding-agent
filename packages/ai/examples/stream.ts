import { loadRootEnv } from "@examples/utils/env";
import type { AssistantMessage, Context, Model, ProviderDirectory } from "@/index";
import { createProviderDirectory } from "@/providers/registry";

export const DEFAULT_MODELS: Record<string, string> = {
  google: "gemini-3.6-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  opencode: "big-pickle",
  openrouter: "openai/gpt-4o",
  xai: "grok-beta",
};

export const DEFAULT_PROMPT =
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

export interface StreamRunOptions {
  maxTokens?: number;
  systemPrompt?: string;
  onDelta?: (delta: string) => void;
  onError?: (errorMessage: string) => void;
}

/**
 * Executes a streaming prompt against the given model and models registry.
 * Encapsulates the core library stream API workflow.
 */
export async function runStream(
  models: ProviderDirectory,
  model: Model,
  prompt: string,
  options: StreamRunOptions = {},
): Promise<AssistantMessage> {
  const context: Context = {
    systemPrompt: options.systemPrompt ?? "You are a helpful and concise coding assistant.",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  const eventStream = models.stream(model, context, { maxTokens: options.maxTokens ?? 2000 });

  for await (const event of eventStream) {
    switch (event.type) {
      case "text_delta":
        if (options.onDelta) {
          options.onDelta(event.delta);
        } else {
          process.stdout.write(event.delta);
        }
        break;
      case "error":
        if (options.onError) {
          options.onError(event.error.errorMessage ?? "Unknown error");
        } else {
          console.error(`\n❌ [Stream Error]: ${event.error.errorMessage}`);
        }
        break;
    }
  }

  return await eventStream.result();
}

/**
 * Resolves the provider and model based on user arguments or defaults.
 */
export async function resolveProviderAndModel(
  models: ProviderDirectory,
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
  // Load root .env before resolving providers
  loadRootEnv();

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const [argProvider, argModel, ...promptParts] = args;
  const prompt = promptParts.length > 0 ? promptParts.join(" ") : DEFAULT_PROMPT;

  const models = createProviderDirectory();
  const { model, providerId } = await resolveProviderAndModel(models, argProvider, argModel);
  const provider = models.getProvider(providerId);

  // Check credentials warning
  const apiKey = await provider?.auth.apiKey?.resolve();
  if (!apiKey) {
    console.warn(
      `\n⚠️  [Warning] No API key detected for provider '${providerId}'. The request may fail.`,
    );
    console.warn(`   Please ensure required environment variables are configured in .env.\n`);
  }

  console.log("==================================================");
  console.log(`🤖 Provider : ${providerId}`);
  console.log(`📦 Model    : ${model.id} (${model.name})`);
  console.log(`💬 Prompt   : "${prompt}"`);
  console.log("==================================================\n");

  let textReceived = false;
  const startTime = Date.now();

  const finalMessage = await runStream(models, model, prompt, {
    onDelta: (delta) => {
      process.stdout.write(delta);
      textReceived = true;
    },
  });

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
