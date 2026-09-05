import OpenAI from "openai";
import type { AssistantMessage, Context, Model, StopReason, StreamOptions } from "@/types";
import { AssistantMessageEventStream } from "@/utils/event-stream";

export type OpenAIRawFinishReason =
  | OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"]
  | (string & {});

export function mapOpenAIFinishReason(
  reason: OpenAIRawFinishReason | null | undefined,
): StopReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

export function buildParams(
  context: Context,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

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

      const client = new OpenAI({
        apiKey,
        baseURL: options?.baseURL,
      });
      const messages = buildParams(context);

      const response = await client.chat.completions.create({
        model: model.id,
        messages: messages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
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

      for await (const chunk of response) {
        const choice = chunk.choices[0];
        if (choice?.finish_reason != null) {
          stopReason = mapOpenAIFinishReason(choice.finish_reason);
        }
        const delta = choice?.delta?.content || "";
        if (delta) {
          currentText += delta;
          partialMsg.content = [{ type: "text", text: currentText }];
          eventStream.push({ type: "text_delta", delta, partial: partialMsg });
        }
      }

      partialMsg.stopReason = stopReason;
      eventStream.push({ type: "done", reason: stopReason, message: partialMsg });
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
