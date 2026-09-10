import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, Context, Model, StopReason, StreamOptions } from "@/types";
import { AssistantMessageEventStream } from "@/utils/event-stream";

export type AnthropicRawStopReason =
  | Anthropic.RawMessageDeltaEvent.Delta["stop_reason"]
  | (string & {});

export function mapAnthropicStopReason(
  reason: AnthropicRawStopReason | null | undefined,
): StopReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    default:
      return "stop";
  }
}

export function buildParams(context: Context): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.text).join("");
      messages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content =
        typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.text).join("");
      messages.push({ role: "assistant", content });
    }
  }

  return messages;
}

export function stream(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const eventStream = new AssistantMessageEventStream();

  (async () => {
    try {
      const apiKey = await options?.apiKey;
      if (!apiKey) {
        eventStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            model: model.id,
            stopReason: "error",
            errorMessage: "API key is required",
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

      const stream = await client.messages.create({
        model: model.id,
        messages: messages,
        system: context.systemPrompt,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens || 4096,
        stream: true,
      });

      let currentText = "";
      let stopReason: StopReason = "stop";
      const partialMsg: AssistantMessage = {
        role: "assistant",
        content: [],
        model: model.id,
        stopReason: "stop",
      };

      eventStream.push({ type: "start", partial: partialMsg });

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          const delta = chunk.delta.text;
          currentText += delta;
          partialMsg.content = [{ type: "text", text: currentText }];
          eventStream.push({ type: "text_delta", delta, partial: partialMsg });
        } else if (chunk.type === "message_delta") {
          if (chunk.delta.stop_reason != null) {
            stopReason = mapAnthropicStopReason(chunk.delta.stop_reason);
          }
        } else if (chunk.type === "message_stop") {
          partialMsg.stopReason = stopReason;
          eventStream.push({ type: "done", reason: stopReason, message: partialMsg });
        }
      }

      eventStream.end();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorMsg: AssistantMessage = {
        role: "assistant",
        content: [],
        model: model.id,
        stopReason: "error",
        errorMessage,
      };
      eventStream.push({ type: "error", reason: "error", error: errorMsg });
      eventStream.end();
    }
  })();

  return eventStream;
}
