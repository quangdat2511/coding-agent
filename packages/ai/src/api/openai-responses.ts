import OpenAI from "openai";
import type {
  AssistantMessage,
  Context,
  FinishReason,
  Model,
  ModelStream,
  StreamOptions,
  TextBlock,
  ToolCallBlock,
  Usage,
} from "../types.ts";

import { createModelEventStream } from "../utils/event-stream.ts";
import { flattenMessageContent } from "../utils/messages.ts";
import { sanitizeMaxRetries } from "../utils/retry.ts";

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

/**
 * Tracks an in-progress tool call being assembled from streamed delta chunks.
 * OpenAI streams tool arguments as `delta.tool_calls[n].function.arguments`
 * fragments identified by `index`.
 */
interface PendingToolCall {
  blockIndex: number;
  index: number;
  id: string;
  name: string;
  argumentsAccumulator: string;
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
        // Delegate fetch dynamically to globalThis so runtime interceptors, test mocks,
        // and environment proxies are resolved on each request rather than frozen at module load.
        fetch: (url, init) => globalThis.fetch(url, init),
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

      let nextBlockIndex = 0;
      let activeTextBlockIndex: number | null = null;
      let currentText = "";
      let finishReason: FinishReason | undefined;
      let usage: Usage | undefined;

      // Tool call tracking: OpenAI tool_call index → pending tool call
      const pendingToolCalls = new Map<number, PendingToolCall>();
      // Completed content blocks recorded by blockIndex to preserve chronological order
      const completedBlocksByIndex = new Map<number, TextBlock | ToolCallBlock>();

      for await (const chunk of response) {
        const choice = chunk.choices?.[0];

        if (choice?.finish_reason != null) {
          finishReason = mapOpenAIFinishReason(choice.finish_reason);
        }

        // Handle text deltas
        const textDelta = choice?.delta?.content;
        if (textDelta) {
          // If tool calls were active before text deltas arrived, close them first to preserve wire order.
          if (pendingToolCalls.size > 0) {
            const sortedPendingToolCalls = Array.from(pendingToolCalls.values()).sort(
              (a, b) => a.blockIndex - b.blockIndex,
            );
            for (const pending of sortedPendingToolCalls) {
              eventStream.push({
                type: "content_block_stop",
                index: pending.blockIndex,
              });
              completedBlocksByIndex.set(pending.blockIndex, {
                type: "tool_call",
                toolCallId: pending.id,
                name: pending.name,
                arguments: pending.argumentsAccumulator,
              });
            }
            pendingToolCalls.clear();
          }

          if (activeTextBlockIndex === null) {
            activeTextBlockIndex = nextBlockIndex++;
            eventStream.push({
              type: "content_block_start",
              index: activeTextBlockIndex,
              block: { type: "text", text: "" },
            });
          }
          currentText += textDelta;
          eventStream.push({
            type: "content_block_delta",
            index: activeTextBlockIndex,
            delta: { type: "text_delta", text: textDelta },
          });
        }

        // Handle tool call deltas
        const toolCallDeltas = choice?.delta?.tool_calls;
        if (toolCallDeltas) {
          // If a text block was active before tool calls arrived, close it first to preserve wire order.
          if (activeTextBlockIndex !== null) {
            eventStream.push({
              type: "content_block_stop",
              index: activeTextBlockIndex,
            });
            completedBlocksByIndex.set(activeTextBlockIndex, { type: "text", text: currentText });
            activeTextBlockIndex = null;
            currentText = "";
          }

          for (const tcDelta of toolCallDeltas) {
            const tcIndex = tcDelta.index;

            if (tcIndex === undefined) continue;

            // First chunk for this tool call carries the id.
            // Guard against duplicate id from proxies (OpenRouter, Groq, LiteLLM) resetting accumulator.
            if (tcDelta.id && !pendingToolCalls.has(tcIndex)) {
              const blockIndex = nextBlockIndex++;
              const pending: PendingToolCall = {
                blockIndex,
                index: tcIndex,
                id: tcDelta.id,
                name: tcDelta.function?.name ?? "",
                argumentsAccumulator: tcDelta.function?.arguments ?? "",
              };
              pendingToolCalls.set(tcIndex, pending);

              eventStream.push({
                type: "content_block_start",
                index: blockIndex,
                block: {
                  type: "tool_call",
                  toolCallId: pending.id,
                  name: pending.name,
                  arguments: "",
                },
              });
            } else {
              // Subsequent chunks: accumulate argument fragments.
              const pending = pendingToolCalls.get(tcIndex);
              if (pending) {
                if (tcDelta.function?.name && !pending.name) {
                  pending.name = tcDelta.function.name;
                }
                if (tcDelta.function?.arguments) {
                  pending.argumentsAccumulator += tcDelta.function.arguments;
                }
              }
            }
          }
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

      // Close text block if one was still in flight.
      if (activeTextBlockIndex !== null) {
        eventStream.push({
          type: "content_block_stop",
          index: activeTextBlockIndex,
        });
        completedBlocksByIndex.set(activeTextBlockIndex, { type: "text", text: currentText });
        activeTextBlockIndex = null;
        currentText = "";
      }

      // Finalize all remaining pending tool calls and emit their stop events in order of blockIndex.
      const sortedPendingToolCalls = Array.from(pendingToolCalls.values()).sort(
        (a, b) => a.blockIndex - b.blockIndex,
      );
      for (const pending of sortedPendingToolCalls) {
        eventStream.push({
          type: "content_block_stop",
          index: pending.blockIndex,
        });
        completedBlocksByIndex.set(pending.blockIndex, {
          type: "tool_call",
          toolCallId: pending.id,
          name: pending.name,
          arguments: pending.argumentsAccumulator,
        });
      }
      pendingToolCalls.clear();

      eventStream.push({
        type: "turn_delta",
        finishReason,
        usage,
      });

      // Assemble final message content in exact wire index order.
      const content: AssistantMessage["content"] = Array.from(completedBlocksByIndex.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, block]) => block);

      const finalMsg: AssistantMessage = {
        role: "assistant",
        content,
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
