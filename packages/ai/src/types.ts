import type { TSchema } from "typebox";

// Content blocks
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  name: string;
  arguments: string;
  // Provider Signature: opaque, sent back unchanged with this call on the next request. Only the
  // adapter that produced it reads it.
  signature?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ToolCallBlock;

// Finish reason
export type NormalizedFinishReason =
  | "end_turn"
  | "max_output_tokens"
  | "tool_call"
  | "stop_sequence"
  | "content_filter"
  | "error"
  | "other";

export interface FinishReason {
  reason: NormalizedFinishReason;
  rawReason: string;
}

// Usage
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  raw?: Record<string, unknown>;
}

// Model capabilities
export interface ModelCapabilities {
  readonly parallelToolCallControl: boolean;
  readonly cancellation: "client_abort_only" | "native_in_flight";
  readonly toolArgumentDelivery: "streamed" | "whole";
  readonly usageTiming: "incremental" | "final";
  readonly serverSideTools: boolean;
}

// API-variant selector (ADR 0004 §2, ADR 0006 §2)
//
// Covers all API families that the MVP and its planned extensions may speak.
// Values beyond the current five MVP variants ("responses", "interactions") are
// included so provider options can declare forward-compatibility without a
// breaking type change when new variants land.
export type ApiVariant =
  | "messages"
  | "chat_completions"
  | "generate_content"
  | "responses"
  | "interactions";

// Model
export interface Model {
  id: string;
  name: string;
  provider: string;
  capabilities?: ModelCapabilities;
}

// Messages
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

export type Message = UserMessage | AssistantMessage;

// Tools
export interface ToolDeclaration<S extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
}

// Context
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: readonly ToolDeclaration[];
}

// Stream
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  apiKey?: string | Promise<string | undefined>;
  baseURL?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  signal?: AbortSignal;
  // Honoured only where the model declares parallelToolCallControl.
  parallelToolCalls?: boolean;
}

export type ContentBlockDelta = { type: "text_delta"; text: string };

export type ModelStreamEvent =
  | { type: "stream_start" }
  | { type: "content_block_start"; index: number; block: AssistantContentBlock }
  | { type: "content_block_delta"; index: number; delta: ContentBlockDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "turn_delta"; usage?: Usage; finishReason?: FinishReason }
  | { type: "turn_end"; message: AssistantMessage }
  | {
      type: "error";
      error: {
        message: string;
        code?: string;
        // The HTTP status of the provider response that failed the request, when one arrived.
        // The Chat Completions adapter (openai, openrouter, xai, opencode) records it; the Anthropic
        // and Google adapters do not. ADR 0005 §7 reads it to decide whether a trial is rerun.
        httpStatus?: number;
      };
    };

export type ModelStream = AsyncIterable<ModelStreamEvent> & {
  result(): Promise<AssistantMessage>;
};
