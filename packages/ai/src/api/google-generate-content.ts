/**
 * Google `generateContent` streaming adapter.
 *
 * Calls the Gemini REST endpoint `models/{model}:streamGenerateContent?alt=sse`
 * via raw `fetch` (no SDK), so the transport interceptor (`globalThis.fetch`)
 * exercises the full path during fixture replay.
 *
 * Key differences from the OpenAI Chat Completions adapter:
 * - SSE `data:` lines carry `GenerateContentResponse` JSON
 * - Tool call arguments arrive as a complete JSON object (`functionCall.args`),
 *   never streamed as fragments (whole delivery, ADR 0006 §2)
 * - No `[DONE]` sentinel; the stream closes after the last data line
 * - Roles: `user` / `model` (not `user` / `assistant`)
 * - System prompt lives in `system_instruction`, not a `system` message
 * - Usage fields: `promptTokenCount` / `candidatesTokenCount`
 */

import type {
  AssistantMessage,
  Context,
  FinishReason,
  Model,
  ModelStream,
  NormalizedFinishReason,
  StreamOptions,
  TextBlock,
  ToolCallBlock,
  Usage,
} from "../types.ts";

import { createModelEventStream } from "../utils/event-stream.ts";
import { sanitizeMaxRetries } from "../utils/retry.ts";

// ---------------------------------------------------------------------------
// Google-specific types (subset of GenerateContentResponse)
// ---------------------------------------------------------------------------

interface GoogleFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown> | string | null;
}

interface GoogleFunctionResponse {
  id?: string;
  name: string;
  // Google documents `output` for a result and `error` for a failure.
  response: { output: string } | { error: string };
}

interface GooglePart {
  text?: string;
  functionCall?: GoogleFunctionCall;
  functionResponse?: GoogleFunctionResponse;
  thoughtSignature?: string;
}

// Models before Gemini 3 issue no Tool Call id, so the adapter makes one up with this prefix. A
// made-up id is never sent back: Google would not recognise it.
const SYNTHETIC_ID_PREFIX = "google-fc-";

const issuedId = (toolCallId: string): { id?: string } =>
  toolCallId.startsWith(SYNTHETIC_ID_PREFIX) ? {} : { id: toolCallId };

const onlyFunctionResponses = (parts: readonly GooglePart[]): boolean =>
  parts.length > 0 && parts.every((part) => part.functionResponse !== undefined);

interface GoogleContent {
  parts?: GooglePart[];
  role?: string;
}

interface GoogleCandidate {
  content?: GoogleContent;
  finishReason?: string;
  index?: number;
}

interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GoogleGenerateContentResponse {
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
}

function extractUsage(meta?: GoogleUsageMetadata): Usage | undefined {
  if (!meta) return undefined;
  const usage: Usage = {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
  };
  if (meta.cachedContentTokenCount !== undefined) {
    usage.cachedInputTokens = meta.cachedContentTokenCount;
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Finish-reason mapping
// ---------------------------------------------------------------------------

export type GoogleRawFinishReason = string;

export function mapGoogleFinishReason(
  reason: GoogleRawFinishReason | null | undefined,
): FinishReason {
  const rawReason = reason ?? "unknown";

  const mapping: Record<string, NormalizedFinishReason> = {
    STOP: "end_turn",
    MAX_TOKENS: "max_output_tokens",
    SAFETY: "content_filter",
    RECITATION: "content_filter",
    LANGUAGE: "content_filter",
    BLOCKLIST: "content_filter",
    PROHIBITED_CONTENT: "content_filter",
    SPII: "content_filter",
    MALFORMED_FUNCTION_CALL: "error",
  };

  const normalized = reason ? mapping[reason] : undefined;
  return { reason: normalized ?? "other", rawReason };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface GoogleRequestBody {
  contents: Array<{
    role: string;
    parts: GooglePart[];
  }>;
  system_instruction?: { parts: Array<{ text: string }> };
  tools?: Array<{
    function_declarations: Array<{
      name: string;
      description: string;
      parameters?: unknown;
    }>;
  }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

export function buildRequestBody(context: Context): GoogleRequestBody {
  const body: GoogleRequestBody = { contents: [] };

  // System prompt → system_instruction
  if (context.systemPrompt) {
    body.system_instruction = {
      parts: [{ text: context.systemPrompt }],
    };
  }

  // A functionResponse must name its function, and a Tool Result carries only the call's id.
  const toolNames = new Map<string, string>();

  // Messages → contents
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts: GooglePart[] = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else {
            const name = toolNames.get(block.toolCallId);
            if (name === undefined) {
              throw new Error(`tool_result "${block.toolCallId}" answers no earlier tool_call`);
            }
            parts.push({
              functionResponse: {
                ...issuedId(block.toolCallId),
                name,
                response: block.isError ? { error: block.content } : { output: block.content },
              },
            });
          }
        }
      }
      // A turn's functionResponse parts must share one content, as many as the turn made calls,
      // while a Context may carry each Tool Result in its own message.
      const previous = body.contents.at(-1);
      if (
        previous?.role === "user" &&
        onlyFunctionResponses(previous.parts) &&
        onlyFunctionResponses(parts)
      ) {
        previous.parts.push(...parts);
      } else {
        body.contents.push({ role: "user", parts });
      }
    } else {
      // assistant → model
      const parts: GooglePart[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({
            text: block.text,
            ...(block.signature !== undefined ? { thoughtSignature: block.signature } : {}),
          });
        } else if (block.type === "tool_call") {
          toolNames.set(block.toolCallId, block.name);
          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(block.arguments);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // Keep empty object fallback if malformed or non-object JSON
          }
          parts.push({
            functionCall: {
              ...issuedId(block.toolCallId),
              name: block.name,
              args,
            },
            ...(block.signature !== undefined ? { thoughtSignature: block.signature } : {}),
          });
        }
      }
      body.contents.push({ role: "model", parts });
    }
  }

  // Tool declarations
  if (context.tools && context.tools.length > 0) {
    body.tools = [
      {
        function_declarations: context.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  return body;
}

// ---------------------------------------------------------------------------
// SSE line parser
// ---------------------------------------------------------------------------

function parseSseLine(line: string): GoogleGenerateContentResponse | null {
  if (!line.startsWith("data: ")) return null;
  const json = line.slice("data: ".length).trim();
  if (!json || json === "[DONE]") return null;
  try {
    return JSON.parse(json) as GoogleGenerateContentResponse;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stream adapter
// ---------------------------------------------------------------------------

const RETRY_BASE_MS = 50;
const RETRY_MAX_MS = 1000;

function backoffDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

export function stream(model: Model, context: Context, options?: StreamOptions): ModelStream {
  const eventStream = createModelEventStream();

  (async () => {
    try {
      const apiKey = await options?.apiKey;
      if (!apiKey) {
        eventStream.push({
          type: "error",
          error: { message: "API key is required" },
        });
        eventStream.end();
        return;
      }

      const body = buildRequestBody(context);

      if (options?.temperature !== undefined || options?.maxTokens !== undefined) {
        body.generationConfig = {};
        if (options.temperature !== undefined) {
          body.generationConfig.temperature = options.temperature;
        }
        if (options.maxTokens !== undefined) {
          body.generationConfig.maxOutputTokens = options.maxTokens;
        }
      }

      const rawBaseURL = options?.baseURL ?? "https://generativelanguage.googleapis.com/v1beta/";
      const baseURL = `${rawBaseURL.replace(/\/+$/, "")}/`;
      const modelId = model.id.replace(/^models\//, "");
      const url = `${baseURL}models/${modelId}:streamGenerateContent?alt=sse`;

      const maxRetries = sanitizeMaxRetries(options?.maxRetries);
      let response: Response | undefined;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Like the SDK clients, send nothing once aborted, including after a backoff.
          options?.signal?.throwIfAborted();
          response = await globalThis.fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
              ...options?.headers,
            },
            body: JSON.stringify(body),
            signal: options?.signal,
          });

          if (response.ok) break;

          // Retryable server errors (5xx, 429)
          const status = response.status;
          if (attempt < maxRetries && (status >= 500 || status === 429)) {
            lastError = new Error(`HTTP ${status}: ${response.statusText}`);
            // Release the connection rather than leave the unread body to garbage collection.
            await response.body?.cancel();
            await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
            continue;
          }

          // Non-retryable error
          const errorBody = await response.text();
          throw new Error(`Google API error ${status}: ${errorBody}`);
        } catch (err) {
          if ((err as Error)?.name === "AbortError" || options?.signal?.aborted) {
            throw err;
          }
          if (
            attempt < maxRetries &&
            !(err instanceof Error && err.message.startsWith("Google API error"))
          ) {
            lastError = err instanceof Error ? err : new Error(String(err));
            await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
            continue;
          }
          throw err;
        }
      }

      if (!response?.ok) {
        throw lastError ?? new Error("Failed to connect to Google API");
      }

      eventStream.push({ type: "stream_start" });

      let nextBlockIndex = 0;
      let activeTextBlockIndex: number | null = null;
      let currentText = "";
      // Gemini 3 may sign a text part, often an empty last one; the signature goes back with it.
      let currentTextSignature: string | undefined;
      let finishReason: FinishReason | undefined;
      let usage: Usage | undefined;
      const completedBlocksByIndex = new Map<number, TextBlock | ToolCallBlock>();
      const currentTextBlock = (): TextBlock => ({
        type: "text",
        text: currentText,
        ...(currentTextSignature !== undefined ? { signature: currentTextSignature } : {}),
      });

      // Read the SSE stream line by line
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Response body is not readable");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const chunk = parseSseLine(line);
          if (!chunk) continue;

          const candidate = chunk.candidates?.[0];
          if (!candidate) {
            // Usage-only chunk (no candidate)
            if (chunk.usageMetadata) {
              usage = extractUsage(chunk.usageMetadata);
            }
            continue;
          }

          // Finish reason
          if (candidate.finishReason) {
            finishReason = mapGoogleFinishReason(candidate.finishReason);
          }

          // Usage metadata
          if (chunk.usageMetadata) {
            usage = extractUsage(chunk.usageMetadata);
          }

          // Process parts
          const parts = candidate.content?.parts;
          if (!parts) continue;

          for (const part of parts) {
            if (
              part.text !== undefined &&
              (part.text.length > 0 || activeTextBlockIndex !== null)
            ) {
              if (activeTextBlockIndex === null) {
                activeTextBlockIndex = nextBlockIndex++;
                eventStream.push({
                  type: "content_block_start",
                  index: activeTextBlockIndex,
                  block: { type: "text", text: "" },
                });
              }
              currentText += part.text;
              if (part.thoughtSignature !== undefined) currentTextSignature = part.thoughtSignature;
              eventStream.push({
                type: "content_block_delta",
                index: activeTextBlockIndex,
                delta: { type: "text_delta", text: part.text },
              });
            } else if (part.functionCall) {
              // Close any active text block first
              if (activeTextBlockIndex !== null) {
                eventStream.push({
                  type: "content_block_stop",
                  index: activeTextBlockIndex,
                });
                completedBlocksByIndex.set(activeTextBlockIndex, currentTextBlock());
                activeTextBlockIndex = null;
                currentText = "";
                currentTextSignature = undefined;
              }

              // Function call — arguments arrive whole (never streamed)
              const toolCallId =
                part.functionCall.id ??
                `${SYNTHETIC_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}-${nextBlockIndex}`;
              const blockIndex = nextBlockIndex++;
              const argsString =
                typeof part.functionCall.args === "string"
                  ? part.functionCall.args
                  : part.functionCall.args != null
                    ? JSON.stringify(part.functionCall.args)
                    : "{}";

              const toolCallBlock: ToolCallBlock = {
                type: "tool_call",
                toolCallId,
                name: part.functionCall.name,
                arguments: argsString,
                // Gemini 3 rejects the next request unless this comes back with the call.
                ...(part.thoughtSignature !== undefined
                  ? { signature: part.thoughtSignature }
                  : {}),
              };

              eventStream.push({
                type: "content_block_start",
                index: blockIndex,
                block: toolCallBlock,
              });
              eventStream.push({
                type: "content_block_stop",
                index: blockIndex,
              });
              completedBlocksByIndex.set(blockIndex, toolCallBlock);
            }
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        const chunk = parseSseLine(buffer.trim());
        if (chunk) {
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason && !finishReason) {
            finishReason = mapGoogleFinishReason(candidate.finishReason);
          }
          if (chunk.usageMetadata) {
            usage = extractUsage(chunk.usageMetadata);
          }
        }
      }

      if (!finishReason) {
        throw new Error("Stream ended without a finish reason");
      }

      // Close active text block
      if (activeTextBlockIndex !== null) {
        eventStream.push({
          type: "content_block_stop",
          index: activeTextBlockIndex,
        });
        completedBlocksByIndex.set(activeTextBlockIndex, currentTextBlock());
      }

      // Normalize finish reason if tool calls were produced:
      // Google API sends finishReason: "STOP" even when tool calls are generated.
      // Under ADR 0004 §2, any message with tool calls must normalize to "tool_call".
      const hasToolCalls = Array.from(completedBlocksByIndex.values()).some(
        (b) => b.type === "tool_call",
      );
      if (hasToolCalls && finishReason.reason === "end_turn") {
        finishReason = { reason: "tool_call", rawReason: finishReason.rawReason };
      }

      eventStream.push({
        type: "turn_delta",
        finishReason,
        usage,
      });

      // Assemble final message content in exact index order.
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
