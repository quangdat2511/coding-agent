import OpenAI from "openai";
import type {
  AssistantMessage,
  Context,
  FinishReason,
  Model,
  ModelStream,
  StreamOptions,
  Usage,
} from "@/types";

import { createModelEventStream } from "@/utils/event-stream";
import { flattenMessageContent } from "@/utils/messages";
import { sanitizeMaxRetries } from "@/utils/retry";

export type OpenAIRawFinishReason =
  | OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"]
  | (string & {});

export function mapOpenAIFinishReason(
  reason: OpenAIRawFinishReason | null | undefined,
): FinishReason {
  const rawReason = reason ?? "unknown";
  switch (reason) {
    case "stop":
      return { reason: "end_turn", rawReason };
    case "length":
      return { reason: "max_output_tokens", rawReason };
    case "tool_calls":
    case "function_call":
      return { reason: "tool_call", rawReason };
    case "content_filter":
      return { reason: "content_filter", rawReason };
    case "error":
      return { reason: "error", rawReason };
    default:
      return { reason: "other", rawReason: reason ?? "unknown" };
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
    messages.push({
      role: msg.role,
      content: flattenMessageContent(msg),
    });
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

      const client = new OpenAI({
        apiKey,
        baseURL: options?.baseURL,
        defaultHeaders: options?.headers,
        maxRetries: sanitizeMaxRetries(options?.maxRetries),
      });
      const messages = buildParams(context);

      const response = await client.chat.completions.create(
        {
          model: model.id,
          messages: messages,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      );

      eventStream.push({ type: "stream_start" });
      eventStream.push({
        type: "content_block_start",
        index: 0,
        block: { type: "text", text: "" },
      });

      let currentText = "";
      let finishReason: FinishReason | undefined;
      let usage: Usage | undefined;

      for await (const chunk of response) {
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason != null) {
          finishReason = mapOpenAIFinishReason(choice.finish_reason);
        }
        const delta = choice?.delta?.content || "";
        if (delta) {
          currentText += delta;
          eventStream.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta },
          });
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
      }

      if (!finishReason) {
        throw new Error("Stream ended without a finish reason");
      }

      eventStream.push({
        type: "content_block_stop",
        index: 0,
      });

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
