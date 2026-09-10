export interface Model {
  id: string;
  name: string;
  provider: string;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface TextContent {
  type: "text";
  text: string;
}

export interface UserMessage {
  role: "user";
  content: string | TextContent[];
}

export interface AssistantMessage {
  role: "assistant";
  content: TextContent[];
  model: string;
  stopReason: StopReason;
  errorMessage?: string;
}

export type Message = UserMessage | AssistantMessage;

export interface Context {
  systemPrompt?: string;
  messages: Message[];
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  apiKey?: string | Promise<string | undefined>;
  baseURL?: string;
  headers?: Record<string, string>;
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: StopReason; error: AssistantMessage };
