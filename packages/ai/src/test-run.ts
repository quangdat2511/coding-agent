import { builtinModels } from "@/providers/all";
import type { Context } from "@/types";

async function main() {
  // 1. Initialize the Registry with all built-in providers
  console.log("Initializing Models Registry...");
  const models = builtinModels();

  // 2. Get the model
  console.log("Using Gemini via Google Provider...");
  const model = models.getModel("google", "gemini-3.5-flash");
  if (!model) {
    throw new Error("Model gemini-3.5-flash not found in Google provider");
  }

  // 3. Create context
  const context: Context = {
    messages: [
      { role: "user", content: "Hãy viết đoạn văn mô tả trường đại học Khoa học tự nhiên (HCMUS)" },
      { role: "user", content: "Hãy viết đoạn văn mô tả khoa công nghệ thông tin của trường" },
      { role: "user", content: "Ghi nội dung trên vào file markdown" },
    ],
  };

  console.log("Calling the stream API...");
  // 4. Call stream, no need to manually pass baseURL or apiKey since googleProvider handles it automatically
  const eventStream = models.stream(model, context);

  // Listen to chunks
  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "error") {
      console.error("\nError:", event.error.errorMessage);
    }
  }

  // Wait for the stream to finish (receive the done message)
  const finalMessage = await eventStream.result();
  console.log("\n\nStream finished with stopReason:", finalMessage.stopReason);
}

main().catch(console.error);
