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
  ToolDeclaration,
  Usage,
} from "../types.ts";

import { createModelEventStream } from "../utils/event-stream.ts";
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

export function buildTools(
  tools?: readonly ToolDeclaration[],
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));
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
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else {
        const textParts: string[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            throw new Error("tool_result history is not supported by this adapter yet (CDA-43)");
          }
        }
        messages.push({ role: "user", content: textParts.join("") });
      }
    } else {
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_call") {
          toolCalls.push({
            id: block.toolCallId,
            type: "function",
            function: {
              name: block.name,
              arguments: block.arguments,
            },
          });
        }
      }

      const text = textParts.join("");
      const content = toolCalls.length > 0 && text.length === 0 ? null : text;

      messages.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
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
      const tools = buildTools(context.tools);

      const response = await client.chat.completions.create(
        {
          model: model.id,
          messages: messages,
          ...(tools ? { tools } : {}),
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

      function flushActiveTextBlock(): void {
        if (activeTextBlockIndex === null) return;
        eventStream.push({
          type: "content_block_stop",
          index: activeTextBlockIndex,
        });
        completedBlocksByIndex.set(activeTextBlockIndex, { type: "text", text: currentText });
        activeTextBlockIndex = null;
        currentText = "";
      }

      function flushPendingToolCalls(): void {
        if (pendingToolCalls.size === 0) return;
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

      for await (const chunk of response) {
        const choice = chunk.choices?.[0];

        if (choice?.finish_reason != null) {
          finishReason = mapOpenAIFinishReason(choice.finish_reason);
        }

        // Handle text deltas
        const textDelta = choice?.delta?.content;
        if (textDelta) {
          // If tool calls were active before text deltas arrived, close them first to preserve wire order.
          flushPendingToolCalls();

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
          flushActiveTextBlock();

          for (const tcDelta of toolCallDeltas) {
            const tcIndex = tcDelta.index;

            if (tcIndex === undefined) continue;

            // First chunk for this tool call index: initialize tracking.
            // Guard against duplicate id from proxies (OpenRouter, Groq, LiteLLM) resetting accumulator.
            if (!pendingToolCalls.has(tcIndex)) {
              const blockIndex = nextBlockIndex++;
              const toolCallId = tcDelta.id || `call_${blockIndex}`;
              const pending: PendingToolCall = {
                blockIndex,
                index: tcIndex,
                id: toolCallId,
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
              // Subsequent chunks: accumulate argument fragments and update metadata if provided late.
              const pending = pendingToolCalls.get(tcIndex);
              if (pending) {
                if (tcDelta.id && (!pending.id || pending.id.startsWith("call_"))) {
                  pending.id = tcDelta.id;
                }
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
          const rawUsage = chunk.usage as unknown as Record<string, unknown>;
          const promptDetails = rawUsage.prompt_tokens_details as
            | { cached_tokens?: number }
            | undefined;
          const completionDetails = rawUsage.completion_tokens_details as
            | { reasoning_tokens?: number }
            | undefined;

          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            ...(typeof promptDetails?.cached_tokens === "number"
              ? { cachedInputTokens: promptDetails.cached_tokens }
              : {}),
            ...(typeof completionDetails?.reasoning_tokens === "number"
              ? { reasoningTokens: completionDetails.reasoning_tokens }
              : {}),
            raw: rawUsage,
          };
        }
      }

      if (!finishReason) {
        throw new Error("Stream ended without a finish reason");
      }

      // Close any remaining in-flight text block or pending tool calls.
      flushActiveTextBlock();
      flushPendingToolCalls();

      // Normalize finishReason to tool_call when tool calls are present,
      // guarding against upstream proxies that emit stop/other when calling tools.
      const hasToolCalls = Array.from(completedBlocksByIndex.values()).some(
        (b) => b.type === "tool_call",
      );
      if (
        hasToolCalls &&
        finishReason.reason !== "tool_call" &&
        finishReason.reason !== "max_output_tokens" &&
        finishReason.reason !== "content_filter" &&
        finishReason.reason !== "error"
      ) {
        finishReason = {
          reason: "tool_call",
          rawReason: finishReason.rawReason,
        };
      }

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
