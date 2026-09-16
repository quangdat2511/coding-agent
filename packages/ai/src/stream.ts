import type { AssistantMessage, ContentBlock, FinishReason, Usage } from "@/types";

export type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_arguments_delta"; arguments: string };

export type ModelStreamEvent =
  | { type: "stream_start" }
  | { type: "content_block_start"; index: number; block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: ContentBlockDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "turn_delta"; usage?: Usage; finishReason?: FinishReason }
  | { type: "turn_end"; message: AssistantMessage }
  | { type: "error"; error: { message: string; code?: string } };

export type ModelStream = AsyncIterable<ModelStreamEvent> & {
  result(): Promise<AssistantMessage>;
};
