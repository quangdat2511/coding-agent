import { createProviderDirectory } from "../src/index.ts";
import { loadRootEnv } from "./utils/env.ts";

async function main(): Promise<void> {
  loadRootEnv();

  const models = createProviderDirectory();
  const provider = models.getProvider("openrouter");
  if (!provider) {
    throw new Error("OpenRouter provider not found");
  }

  const modelId = process.argv[2] ?? "openai/gpt-4o-mini";
  const model = models.getModel("openrouter", modelId);
  if (!model) {
    throw new Error(`Model ${modelId} not found`);
  }

  console.log("==================================================");
  console.log("Calling OpenRouter Chat Completions Live API with Tool Call");
  console.log(`Model: ${model.id} (${model.name})`);
  console.log("==================================================\n");

  const stream = models.stream(model, {
    messages: [
      {
        role: "user",
        content: "What is the weather in Tokyo right now? Call get_weather to check.",
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "The city name" },
          },
          required: ["city"],
        },
      },
    ],
  });

  for await (const event of stream) {
    console.log(`[Event] ${event.type}`);
    if (event.type === "content_block_start" && event.block.type === "tool_call") {
      console.log(`  -> Tool Call ID: ${event.block.toolCallId}`);
      console.log(`  -> Function Name: ${event.block.name}`);
      console.log("  -> Arguments: (streaming fragments...)");
    }
  }

  const result = await stream.result();

  console.log("\n--------------------------------------------------");
  console.log("Stream Complete:");
  console.log(`Finish Reason: ${result.finishReason.reason} (${result.finishReason.rawReason})`);
  console.log(
    `Usage: inputTokens=${result.usage?.inputTokens}, outputTokens=${result.usage?.outputTokens}${
      result.usage?.cachedInputTokens ? `, cachedInputTokens=${result.usage.cachedInputTokens}` : ""
    }${result.usage?.reasoningTokens ? `, reasoningTokens=${result.usage.reasoningTokens}` : ""}`,
  );
  console.log("Content Blocks:", JSON.stringify(result.content, null, 2));
  console.log("--------------------------------------------------");
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
