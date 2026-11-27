import { describe, expect, it } from "bun:test";
import {
  buildRequestBody,
  mapGoogleFinishReason,
  stream,
} from "../src/api/google-generate-content.ts";
import type { AssistantMessage, Context, Model, ToolCallBlock } from "../src/types.ts";
import { loadFixture, sseResponse, withFixtureFetch } from "./fixtures/fixture-fetch.ts";

const TEST_MODEL: Model = {
  id: "gemini-2.0-flash-lite",
  name: "Gemini 2.0 Flash Lite",
  provider: "google",
};

describe("mapGoogleFinishReason", () => {
  it("maps STOP to end_turn", () => {
    expect(mapGoogleFinishReason("STOP")).toEqual({
      reason: "end_turn",
      rawReason: "STOP",
    });
  });

  it("maps MAX_TOKENS to max_output_tokens", () => {
    expect(mapGoogleFinishReason("MAX_TOKENS")).toEqual({
      reason: "max_output_tokens",
      rawReason: "MAX_TOKENS",
    });
  });

  it("maps safety-related reasons to content_filter", () => {
    for (const r of [
      "SAFETY",
      "RECITATION",
      "LANGUAGE",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
    ]) {
      expect(mapGoogleFinishReason(r)).toEqual({
        reason: "content_filter",
        rawReason: r,
      });
    }
  });

  it("maps malformed function call to error", () => {
    expect(mapGoogleFinishReason("MALFORMED_FUNCTION_CALL")).toEqual({
      reason: "error",
      rawReason: "MALFORMED_FUNCTION_CALL",
    });
  });

  it("maps null, undefined, and unrecognized reasons to other", () => {
    expect(mapGoogleFinishReason(null)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapGoogleFinishReason(undefined)).toEqual({
      reason: "other",
      rawReason: "unknown",
    });
    expect(mapGoogleFinishReason("CUSTOM_REASON")).toEqual({
      reason: "other",
      rawReason: "CUSTOM_REASON",
    });
  });
});

describe("buildRequestBody", () => {
  it("maps systemPrompt to system_instruction", () => {
    const context: Context = {
      systemPrompt: "You are a helpful coding assistant.",
      messages: [],
    };
    const body = buildRequestBody(TEST_MODEL, context);
    expect(body.system_instruction).toEqual({
      parts: [{ text: "You are a helpful coding assistant." }],
    });
  });

  it("maps user and assistant messages with text and tool calls", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "Check weather in Tokyo" },
        {
          role: "assistant",
          model: "gemini-2.0-flash-lite",
          finishReason: { reason: "tool_call", rawReason: "STOP" },
          content: [
            { type: "text", text: "Looking up weather..." },
            {
              type: "tool_call",
              toolCallId: "call_1",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ],
        },
      ],
    };

    const body = buildRequestBody(TEST_MODEL, context);
    expect(body.contents).toHaveLength(2);

    // User turn 1
    expect(body.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "Check weather in Tokyo" }],
    });

    // Assistant turn (role: model)
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Looking up weather..." },
        {
          functionCall: {
            id: "call_1",
            name: "get_weather",
            args: { city: "Tokyo" },
          },
        },
      ],
    });
  });

  const toolCallTurn = (
    ...calls: Array<{ id: string; name: string }>
  ): Context["messages"][number] => ({
    role: "assistant",
    model: "gemini-2.0-flash-lite",
    finishReason: { reason: "tool_call", rawReason: "STOP" },
    content: calls.map(({ id, name }) => ({
      type: "tool_call" as const,
      toolCallId: id,
      name,
      arguments: "{}",
    })),
  });

  it("maps Tool Results to functionResponse parts named after their call, with output or error", () => {
    const context: Context = {
      messages: [
        toolCallTurn({ id: "call_1", name: "get_weather" }, { id: "call_2", name: "read" }),
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "call_1", content: '{"temp": 20}', isError: false },
            { type: "tool_result", toolCallId: "call_2", content: "not found", isError: true },
          ],
        },
      ],
    };

    expect(buildRequestBody(TEST_MODEL, context).contents[1]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call_1",
            name: "get_weather",
            response: { output: '{"temp": 20}' },
          },
        },
        { functionResponse: { id: "call_2", name: "read", response: { error: "not found" } } },
      ],
    });
  });

  it("batches consecutive user messages into one content, so a turn's Tool Results share it", () => {
    const context: Context = {
      messages: [
        toolCallTurn({ id: "call_1", name: "read" }, { id: "call_2", name: "read" }),
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "call_1", content: "one", isError: false }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "call_2", content: "two", isError: false }],
        },
      ],
    };

    const body = buildRequestBody(TEST_MODEL, context);
    expect(body.contents).toHaveLength(2);
    expect(body.contents[1]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "call_1", name: "read", response: { output: "one" } } },
        { functionResponse: { id: "call_2", name: "read", response: { output: "two" } } },
      ],
    });
  });

  it("throws when a Tool Result answers no earlier Tool Call", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "call_9", content: "x", isError: false }],
        },
      ],
    };

    expect(() => buildRequestBody(TEST_MODEL, context)).toThrow(
      'tool_result "call_9" answers no earlier tool_call',
    );
  });

  it("handles malformed JSON arguments in assistant tool_call gracefully", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          model: "gemini-2.0-flash-lite",
          finishReason: { reason: "tool_call", rawReason: "STOP" },
          content: [
            {
              type: "tool_call",
              toolCallId: "call_broken",
              name: "bad_tool",
              arguments: "{not valid json",
            },
          ],
        },
      ],
    };

    const body = buildRequestBody(TEST_MODEL, context);
    expect(body.contents[0]?.parts[0]?.functionCall?.args).toEqual({});
  });

  it("maps tools declarations to function_declarations", () => {
    const context: Context = {
      messages: [],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };

    const body = buildRequestBody(TEST_MODEL, context);
    expect(body.tools).toEqual([
      {
        function_declarations: [
          {
            name: "get_weather",
            description: "Get the current weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    ]);
  });
});

describe("stream finishReason and usage normalization", () => {
  it("emits error event and rejects result() when API key is missing", async () => {
    const context: Context = { messages: [] };
    const ms = stream(TEST_MODEL, context);

    const events: unknown[] = [];
    for await (const event of ms) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "error",
        error: { message: "API key is required" },
      },
    ]);

    expect(ms.result()).rejects.toThrow("API key is required");
  });

  it("normalizes finishReason to tool_call when tool calls are present in the response", async () => {
    const { loadFixture, sseResponse, withFixtureFetch } = await import(
      "./fixtures/fixture-fetch.ts"
    );
    const fixture = sseResponse(loadFixture("google/tool-call.txt"));

    await withFixtureFetch(fixture, async () => {
      const ms = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
      const msg = await ms.result();

      // Under ADR 0004 §2, reason must be normalized to "tool_call"
      // while rawReason preserves provider's "STOP"
      expect(msg.finishReason).toEqual({
        reason: "tool_call",
        rawReason: "STOP",
      });
      expect(msg.content.some((b) => b.type === "tool_call")).toBe(true);
    });
  });

  it("extracts cachedContentTokenCount into usage.cachedInputTokens and strips models/ prefix", async () => {
    const { sseResponse, withFixtureFetch } = await import("./fixtures/fixture-fetch.ts");
    const rawSse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Cached response"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"totalTokenCount":120,"cachedContentTokenCount":80}}\n\n';
    const fixture = sseResponse(rawSse);

    const modelWithPrefix: Model = {
      id: "models/gemini-2.0-flash-lite",
      name: "Gemini 2.0 Flash Lite",
      provider: "google",
    };

    await withFixtureFetch(fixture, async () => {
      const ms = stream(modelWithPrefix, { messages: [] }, { apiKey: "test-key" });
      const msg = await ms.result();

      expect(msg.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 80,
      });
    });
  });

  it("adds thoughtsTokenCount to outputTokens and reports it as reasoningTokens", async () => {
    const rawSse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Thought about it"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":30,"totalTokenCount":150}}\n\n';

    await withFixtureFetch(sseResponse(rawSse), async () => {
      const ms = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
      const msg = await ms.result();

      expect(msg.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 30,
      });
    });
  });

  it("counts the thoughts of a recorded Gemini 3 turn in outputTokens", async () => {
    await withFixtureFetch(
      sseResponse(loadFixture("google/tool-call-thought-signature.txt")),
      async () => {
        const ms = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
        const msg = await ms.result();

        // The recording reports 74 prompt + 32 candidate + 85 thoughts tokens = 191 total.
        expect(msg.usage).toEqual({
          inputTokens: 74,
          outputTokens: 117,
          reasoningTokens: 85,
        });
      },
    );
  });

  it("generates unique synthetic toolCallId across turns with google-fc- prefix", async () => {
    const { loadFixture, sseResponse, withFixtureFetch } = await import(
      "./fixtures/fixture-fetch.ts"
    );
    const makeFixture = () => sseResponse(loadFixture("google/tool-call.txt"));

    let id1 = "";
    let id2 = "";

    await withFixtureFetch(makeFixture(), async () => {
      const ms1 = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
      const msg1 = await ms1.result();
      const tc1 = msg1.content.find((b) => b.type === "tool_call");
      expect(tc1).toBeDefined();
      if (tc1?.type === "tool_call") {
        id1 = tc1.toolCallId;
        expect(id1.startsWith("google-fc-")).toBe(true);
      }
    });

    await withFixtureFetch(makeFixture(), async () => {
      const ms2 = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
      const msg2 = await ms2.result();
      const tc2 = msg2.content.find((b) => b.type === "tool_call");
      expect(tc2).toBeDefined();
      if (tc2?.type === "tool_call") {
        id2 = tc2.toolCallId;
        expect(id2.startsWith("google-fc-")).toBe(true);
      }
    });

    expect(id1).not.toBe(id2);
  });

  it("ignores malformed SSE data lines gracefully in stream", async () => {
    const { sseResponse, withFixtureFetch } = await import("./fixtures/fixture-fetch.ts");
    const rawSse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"index":0}],"modelVersion":"gemini-2.0-flash-lite"}\n\n' +
      "data: {malformed json chunk}\n\n" +
      'data: {"candidates":[{"content":{"parts":[{"text":" world!"}]},"finishReason":"STOP","index":0}],"modelVersion":"gemini-2.0-flash-lite"}\n\n';
    const fixture = sseResponse(rawSse);

    await withFixtureFetch(fixture, async () => {
      const ms = stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" });
      const msg = await ms.result();
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      expect(text).toBe("Hello world!");
    });
  });

  it("normalizes baseURL without trailing slash", async () => {
    const { sseResponse, withCapturingFixtureFetch } = await import("./fixtures/fixture-fetch.ts");
    const rawSse =
      'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP","index":0}],"modelVersion":"gemini-2.0-flash-lite"}\n\n';

    await withCapturingFixtureFetch(
      () => sseResponse(rawSse),
      async (captured) => {
        const ms = stream(
          TEST_MODEL,
          { messages: [] },
          { apiKey: "test-key", baseURL: "https://my-proxy.internal/v1beta" },
        );
        await ms.result();
        expect(captured[0]?.url).toBe(
          "https://my-proxy.internal/v1beta/models/gemini-2.0-flash-lite:streamGenerateContent?alt=sse",
        );
      },
    );
  });
});

describe("Gemini 3 thought signatures and call ids", () => {
  const GEMINI_3: Model = {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    provider: "google",
  };
  const SIGNED_FIXTURE = "google/tool-call-thought-signature.txt";

  interface RecordedCallPart {
    functionCall: { id: string; name: string; args: Record<string, unknown> };
    thoughtSignature?: string;
  }

  // The functionCall parts exactly as Gemini sent them: what the next request must carry back.
  function recordedCallParts(fixture: string): RecordedCallPart[] {
    return loadFixture(fixture)
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .flatMap((line) => JSON.parse(line.slice("data: ".length)).candidates?.[0]?.content?.parts)
      .filter((part) => part?.functionCall !== undefined);
  }

  async function streamTurn(fixture: string): Promise<AssistantMessage> {
    let message: AssistantMessage | undefined;
    await withFixtureFetch(sseResponse(loadFixture(fixture)), async () => {
      message = await stream(GEMINI_3, { messages: [] }, { apiKey: "test-key" }).result();
    });
    if (message === undefined) throw new Error(`${fixture} produced no message`);
    return message;
  }

  // Answers every Tool Call of `turn` the way Agent Core does: one user message per Tool Result.
  function answered(turn: AssistantMessage): Context {
    const calls = turn.content.filter(
      (block): block is ToolCallBlock => block.type === "tool_call",
    );
    return {
      messages: [
        { role: "user", content: "Read the project files" },
        turn,
        ...calls.map((call): Context["messages"][number] => ({
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: call.toolCallId,
              content: `contents of ${call.name}`,
              isError: false,
            },
          ],
        })),
      ],
    };
  }

  // The request body exactly as it goes over the wire.
  async function sentBody(context: Context): Promise<{ contents: Array<{ parts: unknown[] }> }> {
    const sent: unknown[] = [];
    await withFixtureFetch(
      async (request) => {
        sent.push(await request.json());
        return sseResponse(loadFixture("google/text-streaming.txt"));
      },
      async () => {
        await stream(GEMINI_3, context, { apiKey: "test-key" }).result();
      },
    );
    return sent[0] as { contents: Array<{ parts: unknown[] }> };
  }

  const functionCallParts = (parts: unknown[] = []) =>
    parts.filter((part) => typeof part === "object" && part !== null && "functionCall" in part);

  it("keeps each call's thought signature and Gemini-issued id on its tool_call block", async () => {
    const recorded = recordedCallParts(SIGNED_FIXTURE);
    expect(recorded.some((part) => part.thoughtSignature !== undefined)).toBe(true);

    const turn = await streamTurn(SIGNED_FIXTURE);

    expect(turn.content.filter((block) => block.type === "tool_call")).toEqual(
      recorded.map(({ functionCall, thoughtSignature }) => ({
        type: "tool_call",
        toolCallId: functionCall.id,
        name: functionCall.name,
        arguments: JSON.stringify(functionCall.args),
        ...(thoughtSignature === undefined ? {} : { signature: thoughtSignature }),
      })),
    );
  });

  it("sends a recorded signed turn back verbatim, with each Tool Result under its call's id", async () => {
    const recorded = recordedCallParts(SIGNED_FIXTURE);

    const body = await sentBody(answered(await streamTurn(SIGNED_FIXTURE)));

    expect(functionCallParts(body.contents[1]?.parts)).toEqual(recorded);
    expect(body.contents[2]?.parts).toEqual(
      recorded.map(({ functionCall: { id, name } }) => ({
        functionResponse: { id, name, response: { output: `contents of ${name}` } },
      })),
    );
  });

  it("sends a thought signature only with the call Gemini signed", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          model: GEMINI_3.id,
          finishReason: { reason: "tool_call", rawReason: "STOP" },
          content: [
            {
              type: "tool_call",
              toolCallId: "fc_1",
              name: "read",
              arguments: '{"path":"a.ts"}',
              signature: "c2lnbmVk",
            },
            { type: "tool_call", toolCallId: "fc_2", name: "read", arguments: '{"path":"b.ts"}' },
          ],
        },
      ],
    };

    expect(buildRequestBody(GEMINI_3, context).contents[0]?.parts).toEqual([
      {
        functionCall: { id: "fc_1", name: "read", args: { path: "a.ts" } },
        thoughtSignature: "c2lnbmVk",
      },
      { functionCall: { id: "fc_2", name: "read", args: { path: "b.ts" } } },
    ]);
  });

  describe("after a resumed Session changes model", () => {
    const GEMINI_3_PRO: Model = {
      id: "gemini-3-pro-preview",
      name: "Gemini 3 Pro Preview",
      provider: "google",
    };

    function signedTurn(model: string, toolCallId: string, signature: string): AssistantMessage {
      return {
        role: "assistant",
        model,
        finishReason: { reason: "tool_call", rawReason: "STOP" },
        content: [{ type: "tool_call", toolCallId, name: "read", arguments: "{}", signature }],
      };
    }

    function toolResult(toolCallId: string): Context["messages"][number] {
      return {
        role: "user",
        content: [{ type: "tool_result", toolCallId, content: "ok", isError: false }],
      };
    }

    // A Session whose first Coding Task ran on Gemini 3 Flash and whose second ran on Gemini 3 Pro.
    const mixed: Context = {
      messages: [
        { role: "user", content: "Read a.ts" },
        signedTurn(GEMINI_3.id, "fc_flash", "Zmxhc2g="),
        toolResult("fc_flash"),
        { role: "user", content: "Now read b.ts" },
        signedTurn(GEMINI_3_PRO.id, "fc_pro", "cHJv"),
        toolResult("fc_pro"),
      ],
    };

    const sentCallParts = (model: Model) =>
      buildRequestBody(model, mixed).contents.flatMap((content) =>
        content.parts.filter((part) => part.functionCall !== undefined),
      );

    it("keeps the signatures of the calls the requested model wrote", () => {
      expect(sentCallParts(GEMINI_3_PRO)).toContainEqual({
        functionCall: { id: "fc_pro", name: "read", args: {} },
        thoughtSignature: "cHJv",
      });
      expect(sentCallParts(GEMINI_3)).toContainEqual({
        functionCall: { id: "fc_flash", name: "read", args: {} },
        thoughtSignature: "Zmxhc2g=",
      });
    });

    it("treats a model id with the models/ prefix as the same model", () => {
      const prefixed: Model = { ...GEMINI_3_PRO, id: `models/${GEMINI_3_PRO.id}` };
      expect(sentCallParts(prefixed)).toContainEqual({
        functionCall: { id: "fc_pro", name: "read", args: {} },
        thoughtSignature: "cHJv",
      });
    });

    it("sends another model's calls with no signature, and no placeholder signature", () => {
      expect(sentCallParts(GEMINI_3_PRO)).toEqual([
        { functionCall: { id: "fc_flash", name: "read", args: {} } },
        {
          functionCall: { id: "fc_pro", name: "read", args: {} },
          thoughtSignature: "cHJv",
        },
      ]);
    });

    it("sends no signature at all to a model that wrote none of the Session's calls", async () => {
      const sent: string[] = [];
      await withFixtureFetch(
        async (request) => {
          sent.push(await request.text());
          return sseResponse(loadFixture("google/text-streaming.txt"));
        },
        async () => {
          await stream(TEST_MODEL, mixed, { apiKey: "test-key" }).result();
        },
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('"functionCall"');
      expect(sent[0]).not.toContain("Zmxhc2g=");
      expect(sent[0]).not.toContain("cHJv");
      expect(sent[0]).not.toMatch(/thought_?signature/i);
    });
  });

  it("never sends the id it synthesized for a call Gemini issued without one", async () => {
    const turn = await streamTurn("google/tool-call.txt");

    const body = await sentBody(answered(turn));

    expect(body.contents[1]?.parts).toEqual([
      { functionCall: { name: "get_weather", args: { city: "Tokyo" } } },
    ]);
    expect(body.contents[2]?.parts).toEqual([
      {
        functionResponse: { name: "get_weather", response: { output: "contents of get_weather" } },
      },
    ]);
  });
});
