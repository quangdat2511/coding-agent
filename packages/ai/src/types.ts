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
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

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

// StreamOptions
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  apiKey?: string | Promise<string | undefined>;
  baseURL?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  signal?: AbortSignal;
}
