import { describe, expect, it } from "bun:test";
import type { AssistantMessage, FinishReason, ModelStreamEvent } from "@coding-agent/ai";
import type { AgentFailure, AgentResult, SessionEvent } from "../src/index.ts";
import {
  collect,
  failingStream,
  openTestSession,
  type ScriptedTurn,
  textTurn,
  throwingRequest,
  withFinalMessage,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const streamStart: ModelStreamEvent = { type: "stream_start" };

const opening: readonly ModelStreamEvent[] = [
  streamStart,
  { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking" } },
];

const finishingWith = (finishReason: FinishReason): ScriptedTurn =>
  withFinalMessage(textTurn("Looking"), { finishReason });

const failureOf = (result: AgentResult): AgentFailure | undefined =>
  result.outcome === "failed" ? result.failure : undefined;

const endingWith = (message: unknown): ScriptedTurn => [
  streamStart,
  { type: "turn_end", message: message as AssistantMessage },
];

const completeTurn = textTurn("Fixed it.");

const rawStream =
  (...events: readonly unknown[]): ScriptedTurn =>
  () => ({
    async *[Symbol.asyncIterator]() {
      yield* events as ModelStreamEvent[];
    },
    result: () => new Promise(() => {}),
  });

const closingTypes: SessionEvent["type"][] = [
  "assistant_message_completed",
  "model_turn_completed",
  "session_settled",
];

describe("settling a failed Model Turn", () => {
  it.each<{ name: string; turn: ScriptedTurn; failure: AgentFailure }>([
    {
      name: "the request throws",
      turn: throwingRequest(new Error("connection refused")),
      failure: {
        code: "MODEL_FAILURE",
        message: expect.stringContaining("connection refused"),
        details: { phase: "request", reason: "error" },
      },
    },
    {
      name: "the provider reports an error before the stream opens",
      turn: [{ type: "error", error: { message: "API key is required" } }],
      failure: {
        code: "MODEL_FAILURE",
        message: expect.stringContaining("API key is required"),
        details: { phase: "request", reason: "error" },
      },
    },
    {
      name: "the provider reports an error mid-stream",
      turn: [
        ...opening,
        { type: "error", error: { message: "overloaded", code: "overloaded_error" } },
      ],
      failure: {
        code: "MODEL_FAILURE",
        message: expect.stringContaining("overloaded"),
        details: { phase: "stream", reason: "error", rawReason: "overloaded_error" },
      },
    },
    {
      name: "the provider rejects the request with an HTTP status",
      turn: [{ type: "error", error: { message: "rate limited", httpStatus: 429 } }],
      failure: {
        code: "MODEL_FAILURE",
        message: expect.stringContaining("rate limited"),
        details: { phase: "request", reason: "error", httpStatus: 429 },
      },
    },
    {
      name: "the provider reports an error mid-stream with an HTTP status",
      turn: [
        ...opening,
        {
          type: "error",
          error: { message: "unavailable", code: "overloaded_error", httpStatus: 503 },
        },
      ],
      failure: {
        code: "MODEL_FAILURE",
        message: expect.stringContaining("unavailable"),
        details: {
          phase: "stream",
          reason: "error",
          rawReason: "overloaded_error",
          httpStatus: 503,
        },
      },
    },
    {
      name: "the stream breaks mid-response",
      turn: failingStream(opening, new Error("socket hang up")),
      failure: {
        code: "MODEL_FAILURE",
        message: expect.stringContaining("socket hang up"),
        details: { phase: "stream", reason: "error" },
      },
    },
    {
      name: "a content filter blocks the response",
      turn: finishingWith({ reason: "content_filter", rawReason: "SAFETY" }),
      failure: {
        code: "MODEL_FAILURE",
        message: expect.any(String),
        details: { phase: "finish", reason: "content_filter", rawReason: "SAFETY" },
      },
    },
    {
      name: "the response stops at the output token limit",
      turn: finishingWith({ reason: "max_output_tokens", rawReason: "length" }),
      failure: {
        code: "MODEL_FAILURE",
        message: expect.any(String),
        details: { phase: "finish", reason: "max_output_tokens", rawReason: "length" },
      },
    },
    {
      name: "the provider finishes the response with an error",
      turn: finishingWith({ reason: "error", rawReason: "MALFORMED_FUNCTION_CALL" }),
      failure: {
        code: "MODEL_FAILURE",
        message: expect.any(String),
        details: { phase: "finish", reason: "error", rawReason: "MALFORMED_FUNCTION_CALL" },
      },
    },
  ])("settles MODEL_FAILURE when $name", async ({ turn, failure }) => {
    const { session } = openTestSession({ model: { turns: [turn] } });

    await session.dispatch({ type: "start", task });
    const result = await session.result();

    expect(failureOf(result)).toEqual(failure);
    const events = await collect(session.events());
    expect(events.slice(-3).map((event) => event.type)).toEqual(closingTypes);
  });

  it.each<{ name: string; turn: ScriptedTurn }>([
    { name: "the stream ends without a final message", turn: opening },
    { name: "content arrives before the stream opens", turn: completeTurn.slice(1) },
    { name: "the stream opens twice", turn: [streamStart, ...completeTurn] },
    {
      name: "a delta arrives for a block that never started",
      turn: [streamStart, ...completeTurn.slice(2)],
    },
    {
      name: "a block starts twice",
      turn: [...completeTurn.slice(0, 2), ...completeTurn.slice(1)],
    },
    {
      name: "a block stops before it starts",
      turn: [streamStart, { type: "content_block_stop", index: 3 }, ...completeTurn.slice(1)],
    },
    {
      name: "the final message is not from the assistant",
      turn: endingWith({ role: "user", content: "Fixed it." }),
    },
    {
      name: "the final message has no content list",
      turn: endingWith({
        role: "assistant",
        content: "Fixed it.",
        model: "fake-model",
        finishReason: { reason: "end_turn", rawReason: "stop" },
      }),
    },
    {
      name: "a final Tool Call has no name",
      turn: endingWith({
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "call-1", arguments: "{}" }],
        model: "fake-model",
        finishReason: { reason: "tool_call", rawReason: "tool_use" },
      }),
    },
    {
      name: "a final Tool Call's Provider Signature is not a string",
      turn: endingWith({
        role: "assistant",
        content: [
          { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: "{}", signature: 7 },
        ],
        model: "fake-model",
        finishReason: { reason: "tool_call", rawReason: "tool_use" },
      }),
    },
    { name: "the stream yields something that is not an event", turn: rawStream(null) },
    {
      name: "the stream yields an unknown event",
      turn: rawStream(streamStart, { type: "ping" }, ...completeTurn.slice(1)),
    },
    {
      name: "a block starts without a block",
      turn: rawStream(streamStart, { type: "content_block_start", index: 0 }),
    },
    {
      name: "a delta carries no text",
      turn: rawStream(
        ...opening.slice(0, 2),
        { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
        ...completeTurn.slice(3),
      ),
    },
    { name: "an error event carries no error", turn: rawStream(streamStart, { type: "error" }) },
    {
      name: "an error code is not a string",
      turn: rawStream(streamStart, { type: "error", error: { message: "boom", code: { id: 1 } } }),
    },
    ...[
      { label: "a string", httpStatus: "429" },
      { label: "not an integer", httpStatus: 429.5 },
      { label: "below the HTTP range", httpStatus: 42 },
      { label: "above the HTTP range", httpStatus: 600 },
    ].map(({ label, httpStatus }) => ({
      name: `an HTTP status is ${label}`,
      turn: rawStream(streamStart, { type: "error", error: { message: "boom", httpStatus } }),
    })),
    {
      name: "the final message has no finish reason",
      turn: endingWith({ role: "assistant", content: [], model: "fake-model" }),
    },
  ])("settles MODEL_PROTOCOL_ERROR when $name", async ({ turn }) => {
    const { session } = openTestSession({ model: { turns: [turn] } });

    await session.dispatch({ type: "start", task });
    const result = await session.result();

    expect(failureOf(result)).toEqual({
      code: "MODEL_PROTOCOL_ERROR",
      message: expect.any(String),
    });
    const events = await collect(session.events());
    expect(events.slice(-3).map((event) => event.type)).toEqual(closingTypes);
  });

  it("keeps the partial output of a failed response for diagnostics, outside the transcript", async () => {
    const { session, model } = openTestSession({
      model: { turns: [failingStream(opening, new Error("socket hang up"))] },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());
    const failure = failureOf(result);

    expect(events.slice(-3).map(({ type, data }) => ({ type, data }))).toEqual([
      {
        type: "assistant_message_completed",
        data: {
          messageId: "assistant_message-1",
          outcome: "failed",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Looking" }],
            model: "fake-model",
            finishReason: { reason: "error", rawReason: "MODEL_FAILURE" },
          },
          failure,
        },
      },
      {
        type: "model_turn_completed",
        data: {
          modelTurnId: "model_turn-1",
          outcome: "failed",
          usage: { inputTokens: 0, outputTokens: 0 },
          failure,
        },
      },
      { type: "session_settled", data: { result } },
    ]);
    expect(session.snapshot().transcript).toEqual([
      { role: "user", content: "Fix the failing test" },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("reports the blocked response and counts its usage when a content filter stops it", async () => {
    const { session } = openTestSession({
      model: { turns: [finishingWith({ reason: "content_filter", rawReason: "SAFETY" })] },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(
      events.find((event) => event.type === "assistant_message_completed")?.data,
    ).toMatchObject({
      outcome: "failed",
      message: {
        content: [{ type: "text", text: "Looking" }],
        finishReason: { reason: "content_filter", rawReason: "SAFETY" },
      },
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(session.snapshot().transcript).toHaveLength(1);
  });
});
