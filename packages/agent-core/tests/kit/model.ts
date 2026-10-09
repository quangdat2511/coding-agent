import type {
  AssistantMessage,
  Context,
  Model,
  ModelCapabilities,
  ModelStream,
  ModelStreamEvent,
  ToolCallBlock,
} from "@coding-agent/ai";
import type { ModelPort } from "../../src/index.ts";

export type ScriptedTurn = readonly ModelStreamEvent[];

export interface ModelRequest {
  readonly context: Context;
  readonly signal: AbortSignal;
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
    stream(context, { signal }) {
      requests.push({ context, signal });
      const turn = remaining.shift();
      if (!turn) throw new Error(`fake model has no scripted turn for request ${requests.length}`);
      return scriptedStream(turn);
    },
  };
}

function scriptedStream(events: ScriptedTurn): ModelStream {
  const terminal = events.findIndex((event) => event.type === "turn_end" || event.type === "error");
  const delivered = terminal === -1 ? events : events.slice(0, terminal + 1);
  const last = delivered.at(-1);
  const result =
    last?.type === "turn_end"
      ? Promise.resolve(last.message)
      : Promise.reject(
          new Error(last?.type === "error" ? last.error.message : "scripted turn has no turn_end"),
        );
  result.catch(() => {});

  return {
    async *[Symbol.asyncIterator]() {
      yield* delivered;
    },
    result: () => result,
  };
}

export function textTurn(text: string): ScriptedTurn {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    model: defaultIdentity.id,
    finishReason: { reason: "end_turn", rawReason: "stop" },
    usage,
  };

  return [
    { type: "stream_start" },
    { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "turn_end", message },
  ];
}

export function toolCallTurn(
  ...calls: readonly { toolCallId: string; name: string; input: unknown }[]
): ScriptedTurn {
  const blocks: ToolCallBlock[] = calls.map(({ toolCallId, name, input }) => ({
    type: "tool_call",
    toolCallId,
    name,
    arguments: JSON.stringify(input),
  }));
  const message: AssistantMessage = {
    role: "assistant",
    content: blocks,
    model: defaultIdentity.id,
    finishReason: { reason: "tool_call", rawReason: "tool_use" },
    usage,
  };

  return [
    { type: "stream_start" },
    ...blocks.flatMap((block, index): ModelStreamEvent[] => [
      { type: "content_block_start", index, block },
      { type: "content_block_stop", index },
    ]),
    { type: "turn_end", message },
  ];
}
