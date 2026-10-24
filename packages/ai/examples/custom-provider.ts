import {
  type Context,
  type CustomProviderConfig,
  createCustomProvider,
  createProviderDirectory,
  type Model,
} from "../src/index.ts";
import { loadRootEnv } from "./utils/env.ts";

/**
 * Demonstrates registering and streaming from custom LLM providers.
 */

function printUsage(): void {
  console.log(`
Usage:
  bun run packages/ai/examples/custom-provider.ts [baseUrl] [modelId] [prompt]

Arguments:
  baseUrl   API base URL (default: http://localhost:11434/v1 or CUSTOM_BASE_URL env)
  modelId   Model identifier (default: llama3 or CUSTOM_MODEL_ID env)
  prompt    Prompt sent to the model (default: "Viết hàm tính số Fibonacci bằng TypeScript.")

Examples:
  # 1. Local Ollama (default)
  bun run packages/ai/examples/custom-provider.ts

  # 2. Local vLLM / LM Studio
  bun run packages/ai/examples/custom-provider.ts http://localhost:8000/v1 mistral

  # 3. Custom OpenAI-compatible service (e.g. DeepSeek / Groq)
  CUSTOM_API_KEY="sk-..." bun run packages/ai/examples/custom-provider.ts https://api.deepseek.com deepseek-chat "Xin chào"
`);
}

async function main(): Promise<void> {
  loadRootEnv();

  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }

  const baseUrl = args[0] || process.env.CUSTOM_BASE_URL || "http://localhost:11434/v1";
  const modelId = args[1] || process.env.CUSTOM_MODEL_ID || "llama3";
  const prompt = args[2] || "Viết hàm tính số Fibonacci bằng TypeScript và giải thích ngắn gọn.";

  console.log("==================================================");
  console.log("  Demonstration: Custom Provider in @coding-agent/ai");
  console.log("==================================================\n");

  const resolvedApiKeyEnv =
    process.env.CUSTOM_API_KEY_ENV ||
    (process.env.CUSTOM_API_KEY ? "CUSTOM_API_KEY" : undefined) ||
    (baseUrl.includes("googleapis.com") && process.env.GOOGLE_API_KEY
      ? "GOOGLE_API_KEY"
      : undefined) ||
    (baseUrl.includes("openrouter.ai") && process.env.OPENROUTER_API_KEY
      ? "OPENROUTER_API_KEY"
      : undefined);

  const customConfig: CustomProviderConfig = {
    id: "my-custom-provider",
    name: "Custom Local / Proxy Provider",
    variant: "chat_completions",
    baseUrl,
    ...(resolvedApiKeyEnv ? { apiKey: `$${resolvedApiKeyEnv}` } : {}),
    headers: {
      "X-Client-Application": "coding-agent-example",
    },
    models: [
      {
        id: modelId,
        name: `Custom Model (${modelId})`,
        capabilities: {
          parallelToolCallControl: true,
          toolArgumentDelivery: "streamed",
        },
      },
      {
        id: "*",
        name: "Wildcard Fallback Model",
      },
    ],
  };

  console.log("1. Creating custom provider from declarative config:");
  console.log(JSON.stringify(customConfig, null, 2));

  const customProvider = createCustomProvider(customConfig);

  const directory = createProviderDirectory();
  directory.setProvider(customProvider);

  const model: Model | undefined = directory.getModel(customProvider.id, modelId);
  if (!model) {
    throw new Error(`Model '${modelId}' could not be resolved from '${customProvider.id}'`);
  }

  const resolvedApiKey = await customProvider.auth.apiKey?.resolve();

  console.log("\n2. Provider successfully registered:");
  console.log(`   - Provider ID : ${customProvider.id} (${customProvider.name})`);
  console.log(`   - Base URL    : ${customProvider.baseUrl}`);
  console.log(`   - Wire Format : ${customProvider.variant}`);
  console.log(
    `   - Auth Key    : ${resolvedApiKey === "no-key" ? "no-key (local runner mode)" : "***"}`,
  );
  console.log(`   - Model ID    : ${model.id} (${model.name})`);
  console.log(`   - Cap Delivery: ${model.capabilities?.toolArgumentDelivery}`);

  console.log("\n3. Sending streaming request:");
  console.log(`   Prompt: "${prompt}"\n`);
  console.log("--- [Stream Output Begin] ---");

  const context: Context = {
    systemPrompt: "You are an expert AI software engineer. Answer clearly and concisely.",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  try {
    const stream = directory.stream(model, context, {
      temperature: 0.2,
      maxTokens: 1024,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
      } else if (event.type === "error") {
        console.error(`\n[Stream Error] ${event.error.message}`);
      }
    }

    const result = await stream.result();

    console.log("\n--- [Stream Output End] ---\n");
    console.log("4. Stream Result Summary:");
    console.log(
      `   - Finish Reason : ${result.finishReason.reason} (${result.finishReason.rawReason})`,
    );
    if (result.usage) {
      console.log(`   - Input Tokens  : ${result.usage.inputTokens ?? "N/A"}`);
      console.log(`   - Output Tokens : ${result.usage.outputTokens ?? "N/A"}`);
    }
  } catch (error) {
    console.log("\n--- [Stream Failed] ---");
    console.error(`\n❌ Failed to connect to ${baseUrl}:`);
    console.error(error instanceof Error ? error.message : String(error));
    console.log("\n💡 Tips to run with a live custom model:");
    console.log("   • For Ollama: install Ollama, then run `ollama serve` and `ollama run llama3`");
    console.log("   • For remote OpenAI-compatible API (e.g. DeepSeek):");
    console.log(
      '     CUSTOM_API_KEY="sk-..." bun run packages/ai/examples/custom-provider.ts https://api.deepseek.com deepseek-chat',
    );
    console.log("   • See --help for more options.\n");
  }
}

main().catch((err) => {
  console.error("Execution error:", err);
  process.exit(1);
});
