import type {
  AssistantMessage,
  Context,
  Model,
  ModelCapabilities,
  ModelStream,
  ModelStreamEvent,
  ToolCallBlock,
  UserMessage,
} from "@coding-agent/ai";
import type { ModelPort } from "../../src/index.ts";

export type ScriptedTurn = readonly ModelStreamEvent[] | (() => ModelStream);

export interface ModelRequest {
  readonly context: Context;
  readonly signal: AbortSignal;
  readonly parallelToolCalls: false;
}

export interface FakeModel extends ModelPort {
  readonly requests: readonly ModelRequest[];
}

export interface FakeModelOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly identity?: Model;
  readonly capabilities?: Partial<ModelCapabilities>;
}

const defaultIdentity: Model = { id: "fake-model", name: "Fake Model", provider: "fake" };

const defaultCapabilities: ModelCapabilities = {
  parallelToolCallControl: true,
  cancellation: "client_abort_only",
  toolArgumentDelivery: "whole",
  usageTiming: "final",
  serverSideTools: false,
};

const usage = { inputTokens: 10, outputTokens: 5 };

export function fakeModel({
  turns = [],
  identity = defaultIdentity,
  capabilities,
}: FakeModelOptions = {}): FakeModel {
  const remaining = [...turns];
  const requests: ModelRequest[] = [];

  return {
    identity,
    capabilities: { ...defaultCapabilities, ...capabilities },
    requests,
    stream(context, { signal, parallelToolCalls }) {
      requests.push({ context, signal, parallelToolCalls });
      const turn = remaining.shift();
      if (!turn) throw new Error(`fake model has no scripted turn for request ${requests.length}`);
      return typeof turn === "function" ? turn() : scriptedStream(turn);
    },
  };
}

function scriptedStream(events: readonly ModelStreamEvent[]): ModelStream {
  const terminal = events.findIndex((event) => event.type === "turn_end" || event.type === "error");
  const delivered = terminal === -1 ? events : events.slice(0, terminal + 1);
  return streamOf(async function* () {
    yield* delivered;
  });
}

export function streamOf(source: () => AsyncIterable<ModelStreamEvent>): ModelStream {
  const final = Promise.withResolvers<AssistantMessage>();
  final.promise.catch(() => {});

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source()) {
          if (event.type === "turn_end") final.resolve(event.message);
          if (event.type === "error") final.reject(new Error(event.error.message));
          yield event;
        }
        final.reject(new Error("scripted turn has no turn_end"));
      } catch (error) {
        final.reject(error);
        throw error;
      }
    },
    result: () => final.promise,
  };
}

export function throwingRequest(error: unknown): ScriptedTurn {
  return () => {
    throw error;
  };
}

export function failingStream(events: readonly ModelStreamEvent[], error: unknown): ScriptedTurn {
  return () =>
    streamOf(async function* () {
      yield* events;
      throw error;
    });
}

export function textMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: defaultIdentity.id,
    finishReason: { reason: "end_turn", rawReason: "stop" },
    usage: { ...usage },
  };
}

export function withFinalMessage(
  turn: readonly ModelStreamEvent[],
  patch: Partial<AssistantMessage>,
): readonly ModelStreamEvent[] {
  return turn.map((event) =>
    event.type === "turn_end" ? { ...event, message: { ...event.message, ...patch } } : event,
  );
}

export function textTurn(...chunks: readonly string[]): readonly ModelStreamEvent[] {
  const message = textMessage(chunks.join(""));

  return [
    { type: "stream_start" },
    { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
    ...chunks.map(
      (text): ModelStreamEvent => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
    { type: "content_block_stop", index: 0 },
    { type: "turn_end", message },
  ];
}

export type ScriptedToolCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly signature?: string;
} & ({ readonly input: unknown } | { readonly arguments: string });

export function toolCallMessage(...calls: readonly ScriptedToolCall[]): AssistantMessage {
  const blocks: ToolCallBlock[] = calls.map((call) => ({
    type: "tool_call",
    toolCallId: call.toolCallId,
    name: call.name,
    arguments: "arguments" in call ? call.arguments : JSON.stringify(call.input),
    ...(call.signature === undefined ? {} : { signature: call.signature }),
  }));
  return {
    role: "assistant",
    content: blocks,
    model: defaultIdentity.id,
    finishReason: { reason: "tool_call", rawReason: "tool_use" },
    usage: { ...usage },
  };
}

export function toolCallTurn(...calls: readonly ScriptedToolCall[]): readonly ModelStreamEvent[] {
  const message = toolCallMessage(...calls);

  return [
    { type: "stream_start" },
    ...message.content.flatMap((block, index): ModelStreamEvent[] => [
      { type: "content_block_start", index, block },
      { type: "content_block_stop", index },
    ]),
    { type: "turn_end", message },
  ];
}

export const objective: UserMessage = { role: "user", content: "Fix the failing test" };

export function toolResultMessage(
  toolCallId: string,
  content: string,
  isError = true,
): UserMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolCallId, content, isError }],
  };
}
