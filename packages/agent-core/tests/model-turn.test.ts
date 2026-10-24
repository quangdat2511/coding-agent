import { describe, expect, it } from "bun:test";
import type { AssistantContentBlock, AssistantMessage } from "@coding-agent/ai";
import { Type } from "typebox";
import type { AgentState } from "../src/index.ts";
import {
  collect,
  continueWith,
  openTestSession,
  streamOf,
  textMessage,
  textTurn,
  withFinalMessage,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

describe("running a Model Turn", () => {
  it("settles succeeded when Verification accepts a text response", async () => {
    const { session } = openTestSession({ model: { turns: [textTurn("Fixed it.")] } });

    await session.dispatch({ type: "start", task });

    expect(await session.result()).toEqual({
      outcome: "succeeded",
      finalMessage: textMessage("Fixed it."),
      verification: {
        outcome: "succeeded",
        evidence: [{ type: "no_command_configured", workspaceChanged: false }],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
      workspaceChanged: false,
      partialChangesPossible: false,
      lastSequence: 10,
    });
  });

  it("asks the model with the system prompt, the objective, the tool declarations, and parallel Tool Calls disabled", async () => {
    const { session, model } = openTestSession({ model: { turns: [textTurn("Fixed it.")] } });

    await session.dispatch({ type: "start", task });
    await session.result();

    expect(model.requests).toEqual([
      {
        context: {
          systemPrompt: "You are a coding agent.",
          messages: [{ role: "user", content: "Fix the failing test" }],
          tools: [{ name: "echo", description: "Fake echo tool", parameters: Type.Object({}) }],
        },
        signal: expect.any(AbortSignal),
        parallelToolCalls: false,
      },
    ]);
  });

  it("commits the completed Assistant Message to the transcript after the objective", async () => {
    const { session } = openTestSession({ model: { turns: [textTurn("Fixed it.")] } });

    await session.dispatch({ type: "start", task });
    await session.result();

    expect(session.snapshot().transcript).toEqual([
      { role: "user", content: "Fix the failing test" },
      textMessage("Fixed it."),
    ]);
  });

  it("shows streamed text in the snapshot as it arrives, before the response completes", async () => {
    const observed: AgentState[] = [];
    const events = textTurn("Fix", "ed it.");
    const { session } = openTestSession({
      model: {
        turns: [
          () =>
            streamOf(async function* () {
              for (const event of events) {
                yield event;
                if (event.type === "content_block_delta") observed.push(session.snapshot());
              }
            }),
        ],
      },
    });

    await session.dispatch({ type: "start", task });
    await session.result();

    expect(observed).toMatchObject([
      {
        phase: "streaming_model",
        assistantMessage: {
          messageId: "assistant_message-1",
          blocks: [{ kind: "text", text: "Fix" }],
        },
      },
      {
        phase: "streaming_model",
        assistantMessage: {
          messageId: "assistant_message-1",
          blocks: [{ kind: "text", text: "Fixed it." }],
        },
      },
    ]);
  });

  it("publishes paired message and turn events, with content deltas only between them", async () => {
    const { session } = openTestSession({ model: { turns: [textTurn("Fixed it.")] } });

    await session.dispatch({ type: "start", task });
    await session.result();
    const events = await collect(session.events());

    expect(events.map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "session_started", data: { task } },
      {
        type: "model_turn_started",
        data: {
          modelTurnId: "model_turn-1",
          index: 0,
          model: { id: "fake-model", name: "Fake Model", provider: "fake" },
        },
      },
      {
        type: "assistant_message_started",
        data: { modelTurnId: "model_turn-1", messageId: "assistant_message-1" },
      },
      {
        type: "assistant_content_delta",
        data: { messageId: "assistant_message-1", blockIndex: 0, kind: "text", delta: "Fixed it." },
      },
      {
        type: "assistant_message_completed",
        data: {
          messageId: "assistant_message-1",
          outcome: "completed",
          message: textMessage("Fixed it."),
        },
      },
      {
        type: "candidate_completion_detected",
        data: { modelTurnId: "model_turn-1", messageId: "assistant_message-1" },
      },
      {
        type: "model_turn_completed",
        data: {
          modelTurnId: "model_turn-1",
          outcome: "completed",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      {
        type: "verification_started",
        data: {
          verificationId: "verification-1",
          candidate: { modelTurnId: "model_turn-1", messageId: "assistant_message-1" },
        },
      },
      {
        type: "verification_completed",
        data: {
          verificationId: "verification-1",
          outcome: "succeeded",
          evidence: [{ type: "no_command_configured", workspaceChanged: false }],
        },
      },
      { type: "session_settled", data: { result: await session.result() } },
    ]);
  });

  it("keeps opaque provider reasoning for the next request but never publishes it", async () => {
    const reasoning = {
      type: "reasoning",
      text: "private chain of thought",
      signature: "sig-1",
    } as unknown as AssistantContentBlock;
    const answer: AssistantMessage = {
      ...textMessage("Fixed it."),
      content: [reasoning, { type: "text", text: "Fixed it." }],
    };
    const { session, model } = openTestSession({
      model: {
        turns: [
          [
            { type: "stream_start" },
            { type: "content_block_start", index: 0, block: reasoning },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "private chain of thought" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "Fixed it." },
            },
            { type: "content_block_stop", index: 1 },
            { type: "turn_end", message: answer },
          ],
          textTurn("Fixed it properly."),
        ],
      },
      verification: [continueWith("[Verification Failed]")],
    });

    await session.dispatch({ type: "start", task });
    await session.result();
    const events = await collect(session.events());

    expect(
      events.filter((event) => event.type === "assistant_content_delta").map(({ data }) => data),
    ).toEqual([
      { messageId: "assistant_message-1", blockIndex: 0, kind: "text", delta: "Fixed it." },
      {
        messageId: "assistant_message-2",
        blockIndex: 0,
        kind: "text",
        delta: "Fixed it properly.",
      },
    ]);
    expect(model.requests[1]?.context.messages[1]).toEqual(answer);
  });

  it("accumulates usage across Model Turns, keeping only the token counts", async () => {
    const { session } = openTestSession({
      model: {
        turns: [
          withFinalMessage(textTurn("Fixed it."), {
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: 60,
              raw: { prompt_tokens: 100 },
            },
          }),
          withFinalMessage(textTurn("Fixed it properly."), {
            usage: {
              inputTokens: 150,
              outputTokens: 30,
              reasoningTokens: 12,
            },
          }),
        ],
      },
      verification: [continueWith("[Verification Failed]")],
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(
      events.filter((event) => event.type === "model_turn_completed").map(({ data }) => data.usage),
    ).toEqual([
      { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 },
      { inputTokens: 150, outputTokens: 30, reasoningTokens: 12 },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 250,
      outputTokens: 50,
      cachedInputTokens: 60,
      reasoningTokens: 12,
    });
  });
});
