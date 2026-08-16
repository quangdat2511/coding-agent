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
import { builtinModels } from "@coding-agent/ai/providers/all";
import type { Context } from "@coding-agent/ai/types";

// 1. Initialize the collection of built-in providers (OpenAI, Google, ...)
const models = builtinModels();

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

These types are exported from `@coding-agent/ai/types` to ensure type safety across the project

### 1. `Context` and `Message`

The standard structure for passing conversation history to the model.

```typescript
export interface Context {
  systemPrompt?: string;
  messages: Message[];
}

// Message can be from either the User or the Assistant
export type Message = UserMessage | AssistantMessage;

export interface UserMessage {
  role: "user";
  content: string | TextContent[];
}

export interface AssistantMessage {
  role: "assistant";
  content: TextContent[];
  model: string;
  stopReason: StopReason; // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string;
}
```

### 2. `AssistantMessageEvent`

When calling `models.stream()`, the returned object is an `AssistantMessageEventStream` which can be consumed using `for await`. It emits the following event types:

- **`start`**: Emitted when the API begins sending data. Includes a `partial` draft of the `AssistantMessage`.
- **`text_delta`**: Emitted continuously as text is generated. The `delta` contains the newly generated text chunk.
- **`done`**: Emitted at the end of the stream when generation completes. Contains the full, final `message` and the `reason` it stopped.
- **`error`**: Emitted if an error occurs on the provider's side during streaming.

### 3. `ModelsImpl` and `Provider`

`ModelsImpl` is used to manage and initialize multiple AI APIs.

- **`Provider`**: The interface representing a specific platform (e.g., OpenAI, Anthropic). Each Provider has an `.auth` property for credentials, a `getModels()` function to list supported models, and its own `stream()` implementation.
- **`ModelsImpl`**: Acts as a registry holding all available providers.

```typescript
// Built-in providers include: openai, google, anthropic, openrouter, xai
const models = builtinModels(); 

// Registering a custom provider
models.setProvider(myCustomProvider);

// Getting a reference to a specific provider
const anthropicProvider = models.getProvider("anthropic");
```

### 4. `StreamOptions`

Optional parameters passed when initiating a stream.

```typescript
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  apiKey?: string | Promise<string | undefined>;
  baseURL?: string;
}

// Usage:
models.stream(model, context, { temperature: 0.7, maxTokens: 1000 });
```
