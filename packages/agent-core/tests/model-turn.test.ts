import { describe, expect, it } from "bun:test";
import type { AssistantContentBlock, AssistantMessage } from "@coding-agent/ai";
import { Type } from "typebox";
import type { AgentState } from "../src/index.ts";
import {
  collect,
  continueWith,
  openTestRun,
  streamOf,
  textMessage,
  textTurn,
  toolCallMessage,
  toolCallTurn,
  withFinalMessage,
} from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

describe("running a Model Turn", () => {
  it("settles succeeded when Verification accepts a text response", async () => {
    const { run } = openTestRun({ model: { turns: [textTurn("Fixed it.")] } });

    await run.dispatch({ type: "start", task });

    expect(await run.result()).toEqual({
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
    const { run, model } = openTestRun({ model: { turns: [textTurn("Fixed it.")] } });

    await run.dispatch({ type: "start", task });
    await run.result();

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
    const { run } = openTestRun({ model: { turns: [textTurn("Fixed it.")] } });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(run.snapshot().transcript).toEqual([
      { role: "user", content: "Fix the failing test" },
      textMessage("Fixed it."),
    ]);
  });

  it("shows streamed text in the snapshot as it arrives, before the response completes", async () => {
    const observed: AgentState[] = [];
    const events = textTurn("Fix", "ed it.");
    const { run } = openTestRun({
      model: {
        turns: [
          () =>
            streamOf(async function* () {
              for (const event of events) {
                yield event;
                if (event.type === "content_block_delta") observed.push(run.snapshot());
              }
            }),
        ],
      },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

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
    const { run } = openTestRun({ model: { turns: [textTurn("Fixed it.")] } });

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());

    expect(events.map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "run_started", data: { task } },
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
      { type: "run_settled", data: { result: await run.result() } },
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
    const { run, model } = openTestRun({
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

    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());

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

  it("keeps a Tool Call's Provider Signature in the transcript for the next request", async () => {
    const call = { toolCallId: "fc-1", name: "echo", input: {}, signature: "c2lnbmVkLWNhbGw=" };
    const { run, model } = openTestRun({
      model: { turns: [toolCallTurn(call), textTurn("Fixed it.")] },
    });

    await run.dispatch({ type: "start", task });
    await run.result();

    expect(run.snapshot().transcript[1]).toEqual(toolCallMessage(call));
    expect(model.requests[1]?.context.messages[1]).toEqual(toolCallMessage(call));
  });

  it("accumulates usage across Model Turns, keeping only the token counts", async () => {
    const { run } = openTestRun({
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

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());

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

  it("carries cost and optional usage fields across Model Turns and models in Turn Usage and Usage Totals", async () => {
    const cost1 = {
      input: 0.0001,
      output: 0.0002,
      cacheRead: 0.00001,
      cacheWrite: 0.00005,
      total: 0.00036,
    };
    const cost2 = {
      input: 0.0002,
      output: 0.0005,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.0007,
      totalFromProvider: 0.0007,
    };

    const { run } = openTestRun({
      model: {
        turns: [
          withFinalMessage(textTurn("Fixed it."), {
            model: "claude-haiku-4-5",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: 50,
              cacheWriteTokens: 100,
              cost: cost1,
            },
          }),
          withFinalMessage(textTurn("Continuing fix."), {
            model: "claude-sonnet-5",
            usage: {
              inputTokens: 150,
              outputTokens: 30,
            },
          }),
          withFinalMessage(textTurn("Fixed it properly."), {
            model: "claude-sonnet-5",
            usage: {
              inputTokens: 200,
              outputTokens: 40,
              cost: cost2,
            },
          }),
        ],
      },
      verification: [continueWith("[Verification Failed]"), continueWith("[Verification Failed]")],
    });

    await run.dispatch({ type: "start", task });
    const result = await run.result();
    const events = await collect(run.events());

    const turnUsages = events
      .filter((event) => event.type === "model_turn_completed")
      .map(({ data }) => data.usage);

    // Turn 1 carries cost and cache tokens
    expect(turnUsages[0]).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      cacheWriteTokens: 100,
      cost: cost1,
    });
    // Turn 2 leaves optional fields absent until reported
    const secondTurn = turnUsages[1];
    expect(secondTurn).toEqual({
      inputTokens: 150,
      outputTokens: 30,
    });
    if (!secondTurn) throw new Error("second turn usage missing");
    expect("cost" in secondTurn).toBe(false);
    expect("cachedInputTokens" in secondTurn).toBe(false);
    expect("cacheWriteTokens" in secondTurn).toBe(false);

    // Turn 3 carries cost with provider total
    expect(turnUsages[2]).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cost: cost2,
    });

    // Usage Totals on AgentResult carries accumulated cost and token totals across turns & models
    expect(result.usage.inputTokens).toBe(450);
    expect(result.usage.outputTokens).toBe(90);
    expect(result.usage.cachedInputTokens).toBe(50);
    expect(result.usage.cacheWriteTokens).toBe(100);
    expect(result.usage.cost?.input).toBeCloseTo(0.0003, 8);
    expect(result.usage.cost?.output).toBeCloseTo(0.0007, 8);
    expect(result.usage.cost?.cacheRead).toBeCloseTo(0.00001, 8);
    expect(result.usage.cost?.cacheWrite).toBeCloseTo(0.00005, 8);
    expect(result.usage.cost?.total).toBeCloseTo(0.00106, 8);
    expect(result.usage.cost?.totalFromProvider).toBeCloseTo(0.0007, 8);
  });
});
