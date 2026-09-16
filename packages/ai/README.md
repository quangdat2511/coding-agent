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
    case "start":
      console.log(`[Starting response from ${event.partial.model}]`);
      break;
    
    case "text_delta":
      // Output the text chunks in real-time
      process.stdout.write(event.delta);
      break;
    
    case "done":
      console.log(`\n[Finished. Stop reason: ${event.reason}]`);
      break;
    
    case "error":
      console.error(`\n[Error occurred]: ${event.error.errorMessage}`);
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
- **`content_block_delta`**: Emitted with chunk deltas (`text_delta` or `tool_call_arguments_delta`).
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

## Running Examples

A runnable streaming example is available under `examples/stream.ts`. It demonstrates real-time completions across supported providers:

```bash
# Run with auto-detected provider or default
bun run example

# Or specify provider, model, and custom prompt
bun run example google gemini-3.6-flash "Explain TypeScript advantages"
bun run example openai gpt-4o "Explain monorepo architecture"
```

