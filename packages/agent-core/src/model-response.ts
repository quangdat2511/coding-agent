import type {
  AssistantMessage,
  ModelStream,
  ModelStreamEvent,
  NormalizedFinishReason,
} from "@coding-agent/ai";
import { type Fields, isNonEmptyString, isRecord, messageOf } from "./guards.ts";
import type { AgentFailure } from "./result.ts";

export type ModelResponse =
  | { readonly ok: true; readonly message: AssistantMessage }
  | { readonly ok: false; readonly failure: AgentFailure; readonly message?: AssistantMessage };

type FailurePhase = "request" | "stream" | "finish";

const failedFinishReasons: ReadonlySet<string> = new Set<NormalizedFinishReason>([
  "content_filter",
  "max_output_tokens",
  "error",
]);

const describeFailure = {
  request: "the model request failed",
  stream: "the model stream failed",
  finish: "the model response ended with",
} satisfies Record<FailurePhase, string>;

const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === undefined || check(value);

const isString = (value: unknown): boolean => typeof value === "string";

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const eventShapes = {
  stream_start: () => true,
  content_block_start: ({ index, block }) =>
    isCount(index) && isRecord(block) && isString(block.type),
  content_block_delta: ({ index, delta }) =>
    isCount(index) && isRecord(delta) && isString(delta.text),
  content_block_stop: ({ index }) => isCount(index),
  turn_delta: () => true,
  turn_end: () => true,
  error: ({ error }) =>
    isRecord(error) && isString(error.message) && isOptional(error.code, isString),
} satisfies Record<ModelStreamEvent["type"], (event: Fields) => boolean>;

const isWellFormedEvent = (event: unknown): event is ModelStreamEvent =>
  isRecord(event) &&
  typeof event.type === "string" &&
  Object.hasOwn(eventShapes, event.type) &&
  eventShapes[event.type as ModelStreamEvent["type"]](event);

const isUsableBlock = (block: unknown): boolean =>
  isRecord(block) &&
  isString(block.type) &&
  (block.type !== "text" || isString(block.text)) &&
  (block.type !== "tool_call" ||
    (isNonEmptyString(block.toolCallId) &&
      isNonEmptyString(block.name) &&
      isString(block.arguments)));

const isUsableUsage = (usage: unknown): boolean =>
  isRecord(usage) &&
  isCount(usage.inputTokens) &&
  isCount(usage.outputTokens) &&
  isOptional(usage.cachedInputTokens, isCount) &&
  isOptional(usage.reasoningTokens, isCount);

const isUsableMessage = (message: unknown): message is AssistantMessage =>
  isRecord(message) &&
  message.role === "assistant" &&
  isString(message.model) &&
  Array.isArray(message.content) &&
  message.content.every(isUsableBlock) &&
  isRecord(message.finishReason) &&
  isString(message.finishReason.reason) &&
  isString(message.finishReason.rawReason) &&
  isOptional(message.usage, isUsableUsage);

function usableCopy(message: unknown): AssistantMessage | undefined {
  if (!isUsableMessage(message)) return undefined;
  try {
    return structuredClone(message);
  } catch {
    return undefined;
  }
}

function modelFailure(
  phase: FailurePhase,
  detail: string,
  reason: string,
  rawReason?: string,
): ModelResponse {
  return {
    ok: false,
    failure: {
      code: "MODEL_FAILURE",
      message: `${describeFailure[phase]}: ${detail}`,
      details: { phase, reason, ...(rawReason === undefined ? {} : { rawReason }) },
    },
  };
}

const protocolError = (message: string): ModelResponse => ({
  ok: false,
  failure: { code: "MODEL_PROTOCOL_ERROR", message },
});

function finish(message: AssistantMessage): ModelResponse {
  const { reason, rawReason } = message.finishReason;
  if (!failedFinishReasons.has(reason)) return { ok: true, message };
  return { ...modelFailure("finish", `${reason} (${rawReason})`, reason, rawReason), message };
}

export async function readModelResponse(
  open: () => ModelStream,
  onText: (blockIndex: number, delta: string) => void,
): Promise<ModelResponse> {
  const startedBlocks = new Set<number>();
  const openBlocks = new Set<number>();
  const textBlocks = new Set<number>();
  const displayIndexes = new Map<number, number>();
  let streamOpened = false;
  const phase = (): FailurePhase => (streamOpened ? "stream" : "request");

  let events: AsyncIterator<unknown>;
  try {
    events = open()[Symbol.asyncIterator]();
  } catch (error) {
    return modelFailure("request", messageOf(error), "error");
  }

  try {
    for (;;) {
      let next: IteratorResult<unknown>;
      try {
        next = await events.next();
      } catch (error) {
        return modelFailure(phase(), messageOf(error), "error");
      }
      if (next.done) return protocolError("the model stream ended without a final message");

      const event = next.value;
      if (!isWellFormedEvent(event)) return protocolError("the model sent a malformed event");
      if (event.type === "error") {
        return modelFailure(phase(), event.error.message, "error", event.error.code);
      }
      if (event.type === "stream_start") {
        if (streamOpened) return protocolError("the model stream opened twice");
        streamOpened = true;
        continue;
      }
      if (!streamOpened) {
        return protocolError(`the model sent ${event.type} before opening its stream`);
      }

      switch (event.type) {
        case "content_block_start":
          if (startedBlocks.has(event.index)) {
            return protocolError(`content block ${event.index} started twice`);
          }
          startedBlocks.add(event.index);
          openBlocks.add(event.index);
          if (event.block.type === "text") textBlocks.add(event.index);
          break;
        case "content_block_delta": {
          if (!openBlocks.has(event.index)) {
            return protocolError(
              `a delta arrived for content block ${event.index}, which is not open`,
            );
          }
          if (!textBlocks.has(event.index) || event.delta.text === "") break;
          let blockIndex = displayIndexes.get(event.index);
          if (blockIndex === undefined) {
            blockIndex = displayIndexes.size;
            displayIndexes.set(event.index, blockIndex);
          }
          onText(blockIndex, event.delta.text);
          break;
        }
        case "content_block_stop":
          if (!openBlocks.delete(event.index)) {
            return protocolError(`content block ${event.index} stopped without being open`);
          }
          break;
        case "turn_end": {
          const message = usableCopy(event.message);
          return message === undefined
            ? protocolError("the model returned an unusable final message")
            : finish(message);
        }
      }
    }
  } finally {
    Promise.resolve(events.return?.()).catch(() => {});
  }
}
