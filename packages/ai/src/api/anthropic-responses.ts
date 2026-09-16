import Anthropic from "@anthropic-ai/sdk";
import type { ModelStream } from "@/stream";
import type { AssistantMessage, Context, FinishReason, Model, StreamOptions, Usage } from "@/types";
import { createModelEventStream } from "@/utils/event-stream";

export type AnthropicRawStopReason =
  | Anthropic.RawMessageDeltaEvent.Delta["stop_reason"]
  | (string & {});

export function mapAnthropicFinishReason(
  reason: AnthropicRawStopReason | null | undefined,
): FinishReason {
  const rawReason = reason ?? "unknown";
  switch (reason) {
    case "end_turn":
      return { reason: "end_turn", rawReason };
    case "max_tokens":
      return { reason: "max_output_tokens", rawReason };
    case "tool_use":
      return { reason: "tool_call", rawReason };
    case "refusal":
      return { reason: "content_filter", rawReason };
    case "stop_sequence":
      return { reason: "stop_sequence", rawReason };
    default:
      return { reason: reason ? "other" : "end_turn", rawReason };
  }
}

export function buildParams(context: Context): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((c) => (c.type === "text" ? c.text : c.content)).join("");
      messages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content = msg.content.map((c) => (c.type === "text" ? c.text : c.arguments)).join("");
      messages.push({ role: "assistant", content });
    }
  }

  return messages;
}

export function stream(model: Model, context: Context, options?: StreamOptions): ModelStream {
  const eventStream = createModelEventStream();

  (async () => {
    try {
      const apiKey = await options?.apiKey;
      if (!apiKey) {
        eventStream.push({
          type: "error",
          error: {
            message: "API key is required",
          },
        });
        eventStream.end();
        return;
      }

      const client = new Anthropic({
        apiKey,
        baseURL: options?.baseURL,
        defaultHeaders: options?.headers,
      });
      const messages = buildParams(context);

      const anthropicStream = await client.messages.create({
        model: model.id,
        messages: messages,
        system: context.systemPrompt,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens || 4096,
        stream: true,
      });

      eventStream.push({ type: "stream_start" });
      eventStream.push({
        type: "content_block_start",
        index: 0,
        block: { type: "text", text: "" },
      });

      let currentText = "";
      let finishReason: FinishReason = { reason: "end_turn", rawReason: "unknown" };
      let usage: Usage | undefined;
      let blockStopped = false;

      for await (const chunk of anthropicStream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          const delta = chunk.delta.text;
          currentText += delta;
          eventStream.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta },
          });
        } else if (chunk.type === "content_block_stop") {
          blockStopped = true;
          eventStream.push({
            type: "content_block_stop",
            index: chunk.index,
          });
        } else if (chunk.type === "message_delta") {
          if (chunk.delta.stop_reason != null) {
            finishReason = mapAnthropicFinishReason(chunk.delta.stop_reason);
          }
          if (chunk.usage) {
            usage = {
              inputTokens: 0,
              outputTokens: chunk.usage.output_tokens,
            };
          }
        }
      }

      if (!blockStopped) {
        eventStream.push({
          type: "content_block_stop",
          index: 0,
        });
      }

      eventStream.push({
        type: "turn_delta",
        finishReason,
        usage,
      });

      const finalMsg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: currentText }],
        model: model.id,
        finishReason,
        usage,
      };

      eventStream.push({
        type: "turn_end",
        message: finalMsg,
      });

      eventStream.end();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({
        type: "error",
        error: { message: errorMessage },
      });
      eventStream.end();
    }
  })();

  return eventStream;
}
