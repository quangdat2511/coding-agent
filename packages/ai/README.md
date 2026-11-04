# @coding-agent/ai

A unified abstraction layer for interacting with LLMs. This package standardizes the APIs of various LLM providers, providing a consistent interface for managing conversation history and receiving real-time responses through event streaming

## Installation

This package is designed for internal use within the `coding-agent` ecosystem

```json
{
  "dependencies": {
    "@coding-agent/ai": "workspace:*"
  }
}
```

## Quick Start

The following example demonstrates the fundamental workflow: initializing a provider collection, preparing a conversation context, and using the `stream` method to receive real-time updates

```typescript
import { createProviderDirectory, type Context } from "@coding-agent/ai";

// 1. Initialize the collection of built-in providers (OpenAI, Google, ...)
const models = createProviderDirectory();

// 2. Retrieve a specific model by provider ID and model ID
const model = models.getModel("openai", "gpt-4o");
if (!model) throw new Error("Model not found!");

// 3. Initialize the Context
const context: Context = {
  systemPrompt: "You are a helpful coding assistant.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Hello, could you write a hello world function in TypeScript?" }]
    }
  ]
};

// 4. Start streaming
const stream = models.stream(model, context);

// 5. Iterate through the stream events
for await (const event of stream) {
  switch (event.type) {
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        // Output the text chunks in real-time
        process.stdout.write(event.delta.text);
      }
      break;

    case "turn_end":
      console.log(`\n[Finished. Stop reason: ${event.message.finishReason.reason}]`);
      break;

    case "error":
      console.error(`\n[Error occurred]: ${event.error.message}`);
      break;
  }
}

// 6. Once finished, retrieve the final message and append it to the context for future turns
const finalMessage = await stream.result();
context.messages.push(finalMessage);
```

## Key Interfaces & Types

These types are exported from `@coding-agent/ai` to ensure type safety across the project

### 1. `Context` and `Message`

The standard structure for passing conversation history to the model.

```typescript
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: readonly ToolDeclaration[];
}

export type Message = UserMessage | AssistantMessage;

export interface UserMessage {
  role: "user";
  content: string | (TextBlock | ToolResultBlock)[];
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextBlock | ToolCallBlock)[];
  model: string;
  finishReason: FinishReason;
  usage?: Usage;
}
```

### 2. `ModelStream` and `ModelStreamEvent`

When calling `models.stream()`, the returned object is a structural `ModelStream` (`AsyncIterable<ModelStreamEvent> & { result(): Promise<AssistantMessage> }`). It emits the following event sequence:

- **`stream_start`**: Emitted when stream output begins.
- **`content_block_start`**: Emitted at the start of a content block with `index` and the initial `block`.
- **`content_block_delta`**: Emitted with chunk deltas (`text_delta`).
- **`content_block_stop`**: Emitted when a content block finishes.
- **`turn_delta`**: Emitted with incremental `usage` and/or `finishReason`.
- **`turn_end`**: Emitted at turn completion with the final, complete `AssistantMessage`.
- **`error`**: Emitted with `{ message: string, code?: string }` if a mid-stream or request error occurs.

### 3. `ToolDeclaration`

Tool definitions use TypeBox 1.x schemas:

```typescript
import { Type } from "typebox";

const tool: ToolDeclaration = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: Type.Object({
    location: Type.String(),
  }),
};
```

### 4. `ProviderDirectory` and `Provider`

`ProviderDirectory` is used to manage and initialize multiple AI APIs.

- **`Provider`**: The interface representing a specific platform (e.g., OpenAI, Anthropic). Each Provider has an `.auth` property for credentials, a `getModels()` function to list supported models, and its own `stream()` implementation returning `ModelStream`.
- **`ProviderDirectory`**: Acts as a registry holding all available providers.

```typescript
// Built-in providers include: openai, google, anthropic, openrouter, xai, opencode
const models = createProviderDirectory(); 

// Registering a custom provider
models.setProvider(myCustomProvider);

// Getting a reference to a specific provider
const provider = models.getProvider("anthropic");
```

### 5. `StreamOptions`

Optional parameters passed when initiating a stream.

```typescript
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  apiKey?: string | Promise<string | undefined>;
  baseURL?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  signal?: AbortSignal;
}

// Usage:
models.stream(model, context, { temperature: 0.7, maxTokens: 1000 });
```

### 6. Declarative Custom Providers

You can instantiate custom endpoints (Ollama, vLLM, DeepSeek, custom OpenAI or Anthropic compatible proxies) declaratively from in-memory configuration objects:

```typescript
import { createCustomProvider, createProviderDirectory } from "@coding-agent/ai";

// Create custom provider pointing to a proxy endpoint with environment variable resolution
const customProvider = createCustomProvider({
  id: "deepseek",
  name: "DeepSeek API",
  variant: "chat_completions",
  baseUrl: "https://api.deepseek.com",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
  ],
});

// Or unauthenticated local runner (e.g. Ollama or vLLM)
// If the local runner endpoint does not support parallel tool call control fields,
// override capabilities: { parallelToolCallControl: false } on the model.
const localOllama = createCustomProvider({
  id: "ollama",
  variant: "chat_completions",
  baseUrl: "http://localhost:11434/v1",
  models: [
    {
      id: "llama3",
      capabilities: { parallelToolCallControl: false },
    },
  ],
});

// Register into ProviderDirectory
const directory = createProviderDirectory();
directory.setProvider(customProvider);
directory.setProvider(localOllama);
```


## Running Examples

A runnable streaming example is available under `examples/stream.ts`. It demonstrates real-time completions across supported providers:

```bash
# Run with auto-detected provider or default
bun run example

# Or specify provider, model, and custom prompt
bun run example google gemini-3.6-flash "Explain TypeScript advantages"
bun run example openai gpt-4o "Explain monorepo architecture"

# Run custom provider example (e.g. local Ollama / vLLM / custom proxy)
bun run example:custom
bun run example:custom http://localhost:11434/v1 llama3 "Explain event loop"
```

## Conformance Test Suite & Fixture Recording

`packages/ai` includes a recorded-fixture conformance test suite under `tests/conformance.test.ts`. This suite tests all provider adapters against pre-recorded SSE (Server-Sent Events) fixtures to guarantee that every adapter conforms to the `ModelResponseStream` contract without making live network calls or consuming API credits.

### Fixture Locations

Fixtures are stored under `packages/ai/tests/fixtures/<family>/`:
- `anthropic/`: Fixtures for Anthropic Messages API.
- `openai/`: Fixtures for OpenAI Chat Completions-compatible streaming.
- `xai/`: Fixtures for providers delivering whole tool arguments (e.g. xAI).

Each family provides standard test scenarios:
- `text-streaming.txt`: Basic streaming text chunks.
- `tool-call.txt`: Complete tool call with JSON arguments.
- `tool-call-malformed-args.txt`: Tool call with invalid JSON arguments (verifies raw preservation).
- `finish-reason-length.txt` / `finish-reason-max-tokens.txt`: Max tokens finish reason.
- `usage-totals.txt`: Token usage reporting.

### Refreshing Fixtures

To record or update a fixture:
1. Make a live streaming request outside CI using `curl -N --raw` or by using `withCapturingFixtureFetch` / a local fetch interceptor.
2. Save the raw wire SSE output into the appropriate `.txt` file in `packages/ai/tests/fixtures/<family>/`.
3. Verify that the conformance suite passes:
   ```bash
   bun test tests/conformance.test.ts
   ```


