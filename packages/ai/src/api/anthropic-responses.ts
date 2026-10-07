import Anthropic from "@anthropic-ai/sdk";
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
} from "#src/types";

import { createModelEventStream } from "#src/utils/event-stream";
import { sanitizeMaxRetries } from "#src/utils/retry";

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
      return { reason: "other", rawReason: reason ?? "unknown" };
  }
}

export function buildTools(tools?: readonly ToolDeclaration[]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

interface UsageMetadataContainer {
  cachedInputTokens?: number;
  rawUsage?: Record<string, unknown>;
}

function mergeUsageMetadata(container: UsageMetadataContainer, wireUsage: unknown): void {
  if (!wireUsage || typeof wireUsage !== "object") return;
  const usageRecord = wireUsage as Record<string, unknown>;
  const cacheRead = usageRecord.cache_read_input_tokens;
  if (typeof cacheRead === "number") {
    container.cachedInputTokens = cacheRead;
  }
  container.rawUsage = {
    ...container.rawUsage,
    ...usageRecord,
  };
}

function ensureNonEmptyContent<T>(parts: T[], role: "user" | "assistant"): T[] {
  if (parts.length === 0) {
    throw new Error(`Anthropic messages require at least one content block (role: ${role})`);
  }
  return parts;
}

export function buildParams(context: Context): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length === 0) {
          throw new Error("Anthropic messages require non-empty text content (role: user)");
        }
        messages.push({
          role: "user",
          content: msg.content,
        });
      } else {
        const parts: Anthropic.TextBlockParam[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            if (block.text.trim().length > 0) {
              parts.push({ type: "text", text: block.text });
            }
          } else if (block.type === "tool_result") {
            throw new Error(
              "tool_result history is not supported by the Anthropic adapter yet (CDA-43)",
            );
          }
        }
        messages.push({
          role: "user",
          content: ensureNonEmptyContent(parts, "user"),
        });
      }
    } else {
      const parts: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            parts.push({ type: "text", text: block.text });
          }
        } else if (block.type === "tool_call") {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(block.arguments);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // Keep empty object fallback if malformed or non-object JSON
          }
          parts.push({
            type: "tool_use",
            id: block.toolCallId,
            name: block.name,
            input: args,
          });
        }
      }
      messages.push({
        role: "assistant",
        content: ensureNonEmptyContent(parts, "assistant"),
      });
    }
  }

  return messages;
}

/**
 * Tracks an in-progress tool_use block being assembled from streamed
 * `input_json_delta` chunks.
 */
interface PendingToolBlock {
  index: number;
  toolCallId: string;
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

      const client = new Anthropic({
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

      const anthropicStream = await client.messages.create(
        {
          model: model.id,
          messages: messages,
          system: context.systemPrompt,
          ...(tools ? { tools } : {}),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens || 4096,
          stream: true,
        },
        { signal: options?.signal },
      );

      eventStream.push({ type: "stream_start" });

      let finishReason: FinishReason | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      const usageMeta: UsageMetadataContainer = {};
      let hasUsage = false;

      // Track active text blocks and pending tool blocks by their wire chunk.index
      const activeTextBlocks = new Map<number, string>();
      const pendingToolBlocks = new Map<number, PendingToolBlock>();
      // Completed content blocks recorded by wire index to preserve chronological order
      const completedBlocksByIndex = new Map<number, TextBlock | ToolCallBlock>();

      for await (const chunk of anthropicStream) {
        if (chunk.type === "message_start") {
          if (chunk.message?.usage) {
            hasUsage = true;
            inputTokens = chunk.message.usage.input_tokens ?? 0;
            outputTokens = chunk.message.usage.output_tokens ?? 0;
            mergeUsageMetadata(usageMeta, chunk.message.usage);
          }
        } else if (chunk.type === "content_block_start") {
          if (chunk.content_block.type === "text") {
            activeTextBlocks.set(chunk.index, "");
            eventStream.push({
              type: "content_block_start",
              index: chunk.index,
              block: { type: "text", text: "" },
            });
          } else if (chunk.content_block.type === "tool_use") {
            // Begin assembling a tool_call block.
            pendingToolBlocks.set(chunk.index, {
              index: chunk.index,
              toolCallId: chunk.content_block.id,
              name: chunk.content_block.name,
              argumentsAccumulator: "",
            });
            eventStream.push({
              type: "content_block_start",
              index: chunk.index,
              block: {
                type: "tool_call",
                toolCallId: chunk.content_block.id,
                name: chunk.content_block.name,
                arguments: "",
              },
            });
          }
        } else if (chunk.type === "content_block_delta") {
          if (chunk.delta.type === "text_delta" && activeTextBlocks.has(chunk.index)) {
            const delta = chunk.delta.text;
            const current = activeTextBlocks.get(chunk.index) ?? "";
            activeTextBlocks.set(chunk.index, current + delta);
            eventStream.push({
              type: "content_block_delta",
              index: chunk.index,
              delta: { type: "text_delta", text: delta },
            });
          } else if (chunk.delta.type === "input_json_delta") {
            // Accumulate tool argument fragments — do not parse, pass raw.
            const pending = pendingToolBlocks.get(chunk.index);
            if (pending) {
              pending.argumentsAccumulator += chunk.delta.partial_json;
            }
          }
        } else if (chunk.type === "content_block_stop") {
          if (activeTextBlocks.has(chunk.index)) {
            const text = activeTextBlocks.get(chunk.index) ?? "";
            completedBlocksByIndex.set(chunk.index, { type: "text", text });
            activeTextBlocks.delete(chunk.index);
            eventStream.push({
              type: "content_block_stop",
              index: chunk.index,
            });
          } else if (pendingToolBlocks.has(chunk.index)) {
            const pending = pendingToolBlocks.get(chunk.index);
            if (pending) {
              // Finalize the tool call — arguments stay as the raw accumulated string.
              const toolCallBlock: ToolCallBlock = {
                type: "tool_call",
                toolCallId: pending.toolCallId,
                name: pending.name,
                arguments: pending.argumentsAccumulator,
              };
              completedBlocksByIndex.set(chunk.index, toolCallBlock);
              pendingToolBlocks.delete(chunk.index);
              eventStream.push({
                type: "content_block_stop",
                index: chunk.index,
              });
            }
          }
        } else if (chunk.type === "message_delta") {
          if (chunk.delta.stop_reason != null) {
            finishReason = mapAnthropicFinishReason(chunk.delta.stop_reason);
          }
          if (chunk.usage) {
            hasUsage = true;
            outputTokens = chunk.usage.output_tokens ?? outputTokens;
            mergeUsageMetadata(usageMeta, chunk.usage);
          }
        }
      }

      if (!finishReason) {
        throw new Error("Stream ended without a finish reason");
      }

      // Finalize any active blocks that did not receive a content_block_stop before stream end.
      for (const [idx, text] of activeTextBlocks) {
        completedBlocksByIndex.set(idx, { type: "text", text });
      }
      for (const [idx, pending] of pendingToolBlocks) {
        completedBlocksByIndex.set(idx, {
          type: "tool_call",
          toolCallId: pending.toolCallId,
          name: pending.name,
          arguments: pending.argumentsAccumulator,
        });
      }

      const usage: Usage | undefined = hasUsage
        ? {
            inputTokens,
            outputTokens,
            ...(usageMeta.cachedInputTokens !== undefined
              ? { cachedInputTokens: usageMeta.cachedInputTokens }
              : {}),
            ...(usageMeta.rawUsage ? { raw: usageMeta.rawUsage } : {}),
          }
        : undefined;

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
