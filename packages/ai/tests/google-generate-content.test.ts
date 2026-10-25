import { describe, expect, it } from "bun:test";
import {
  buildRequestBody,
  mapGoogleFinishReason,
  stream,
} from "../src/api/google-generate-content.ts";
import type { Context, Model } from "../src/types.ts";

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
    const body = buildRequestBody(context);
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
              toolCallId: "google-fc-1a2b3c4d-1",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ],
        },
      ],
    };

    const body = buildRequestBody(context);
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
            name: "get_weather",
            args: { city: "Tokyo" },
          },
        },
      ],
    });
  });

  describe("replaying Tool Calls and Tool Results", () => {
    const callTurn = (
      ...calls: Array<{ toolCallId: string; name: string; signature?: string }>
    ): Context["messages"][number] => ({
      role: "assistant",
      model: "gemini-3-flash-preview",
      finishReason: { reason: "tool_call", rawReason: "STOP" },
      content: calls.map((call) => ({ type: "tool_call", arguments: '{"path":"a.ts"}', ...call })),
    });

    it("maps Tool Results to functionResponse parts named after their calls", () => {
      const body = buildRequestBody({
        messages: [
          callTurn({ toolCallId: "google-fc-1a2b3c4d-0", name: "read" }),
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolCallId: "google-fc-1a2b3c4d-0",
                content: "file contents",
                isError: false,
              },
            ],
          },
        ],
      });

      expect(body.contents[1]).toEqual({
        role: "user",
        parts: [{ functionResponse: { name: "read", response: { output: "file contents" } } }],
      });
    });

    it("reports an error Tool Result under the error key", () => {
      const body = buildRequestBody({
        messages: [
          callTurn({ toolCallId: "google-fc-1a2b3c4d-0", name: "read" }),
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolCallId: "google-fc-1a2b3c4d-0",
                content: "NOT_FOUND: a.ts",
                isError: true,
              },
            ],
          },
        ],
      });

      expect(body.contents[1]?.parts).toEqual([
        { functionResponse: { name: "read", response: { error: "NOT_FOUND: a.ts" } } },
      ]);
    });

    it("refuses a Tool Result that answers no earlier Tool Call", () => {
      const context: Context = {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", toolCallId: "call_9", content: "ok", isError: false }],
          },
        ],
      };

      expect(() => buildRequestBody(context)).toThrow(
        'tool_result "call_9" answers no earlier tool_call',
      );
    });

    it("sends back the ids Google issued, and never the ids the adapter made up", () => {
      const body = buildRequestBody({
        messages: [
          callTurn(
            { toolCallId: "8f2kq1xz", name: "read" },
            { toolCallId: "google-fc-1a2b3c4d-1", name: "read" },
          ),
          {
            role: "user",
            content: [
              { type: "tool_result", toolCallId: "8f2kq1xz", content: "one", isError: false },
              {
                type: "tool_result",
                toolCallId: "google-fc-1a2b3c4d-1",
                content: "two",
                isError: false,
              },
            ],
          },
        ],
      });

      expect(body.contents).toEqual([
        {
          role: "model",
          parts: [
            { functionCall: { id: "8f2kq1xz", name: "read", args: { path: "a.ts" } } },
            { functionCall: { name: "read", args: { path: "a.ts" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "8f2kq1xz", name: "read", response: { output: "one" } } },
            { functionResponse: { name: "read", response: { output: "two" } } },
          ],
        },
      ]);
    });

    it("sends a Tool Call's signature back verbatim on its part", () => {
      const body = buildRequestBody({
        messages: [callTurn({ toolCallId: "8f2kq1xz", name: "read", signature: "CiQB0e2Kb9==" })],
      });

      expect(body.contents[0]?.parts).toEqual([
        {
          functionCall: { id: "8f2kq1xz", name: "read", args: { path: "a.ts" } },
          thoughtSignature: "CiQB0e2Kb9==",
        },
      ]);
    });

    it("answers a batch of calls with one content, though each Tool Result has its own message", () => {
      const result = (toolCallId: string, content: string): Context["messages"][number] => ({
        role: "user",
        content: [{ type: "tool_result", toolCallId, content, isError: false }],
      });
      const body = buildRequestBody({
        messages: [
          callTurn({ toolCallId: "fc_1", name: "read" }, { toolCallId: "fc_2", name: "read" }),
          result("fc_1", "one"),
          result("fc_2", "two"),
          { role: "user", content: "Keep going." },
        ],
      });

      expect(body.contents.slice(1)).toEqual([
        {
          role: "user",
          parts: [
            { functionResponse: { id: "fc_1", name: "read", response: { output: "one" } } },
            { functionResponse: { id: "fc_2", name: "read", response: { output: "two" } } },
          ],
        },
        { role: "user", parts: [{ text: "Keep going." }] },
      ]);
    });

    it("replays a Tool Call whose arguments are not a JSON object with empty args", () => {
      const body = buildRequestBody({
        messages: [
          {
            role: "assistant",
            model: "gemini-3-flash-preview",
            finishReason: { reason: "tool_call", rawReason: "STOP" },
            content: [{ type: "tool_call", toolCallId: "fc_1", name: "read", arguments: "[1]" }],
          },
        ],
      });

      expect(body.contents[0]?.parts).toEqual([
        { functionCall: { id: "fc_1", name: "read", args: {} } },
      ]);
    });

    it("sends a text block's signature back on its part", () => {
      const body = buildRequestBody({
        messages: [
          {
            role: "assistant",
            model: "gemini-3-flash-preview",
            finishReason: { reason: "end_turn", rawReason: "STOP" },
            content: [{ type: "text", text: "Done.", signature: "Sig==" }],
          },
        ],
      });

      expect(body.contents[0]?.parts).toEqual([{ text: "Done.", thoughtSignature: "Sig==" }]);
    });
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

    const body = buildRequestBody(context);
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

    const body = buildRequestBody(context);
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

  it("keeps a Gemini 3 Tool Call's id and thought signature", async () => {
    // Built from the documented Gemini 3 response shape rather than recorded: no Google key was
    // available when it was added. Re-record it from a live gemini-3-flash-preview call.
    const { loadFixture, sseResponse, withFixtureFetch } = await import(
      "./fixtures/fixture-fetch.ts"
    );
    const fixture = sseResponse(loadFixture("google/tool-call-thought-signature.txt"));

    await withFixtureFetch(fixture, async () => {
      const msg = await stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" }).result();

      expect(msg.content).toEqual([
        {
          type: "tool_call",
          toolCallId: "8f2kq1xz",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
          signature: "CiQB0e2Kb9xQm3VtR4nL7pYs2wHf8gZcJ1uA6kTqE5oN0dMvXyI=",
        },
      ]);
    });
  });

  it("keeps a thought signature that arrives on an empty last text part", async () => {
    const { sseResponse, withFixtureFetch } = await import("./fixtures/fixture-fetch.ts");
    const rawSse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Done."}],"role":"model"},"index":0}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"Sig=="}],"role":"model"},"finishReason":"STOP","index":0}]}\n\n';

    await withFixtureFetch(sseResponse(rawSse), async () => {
      const msg = await stream(TEST_MODEL, { messages: [] }, { apiKey: "test-key" }).result();

      expect(msg.content).toEqual([{ type: "text", text: "Done.", signature: "Sig==" }]);
    });
  });

  it("sends nothing for a request to disable parallel Tool Calls, which the API cannot honour", async () => {
    const { loadFixture, sseResponse, withFixtureFetch } = await import(
      "./fixtures/fixture-fetch.ts"
    );
    const { Type } = await import("typebox");
    const context: Context = {
      messages: [{ role: "user", content: "Weather in Tokyo?" }],
      tools: [
        {
          name: "get_weather",
          description: "Weather",
          parameters: Type.Object({ city: Type.String() }),
        },
      ],
    };
    const bodies: unknown[] = [];
    await withFixtureFetch(
      async (request) => {
        bodies.push(await request.json());
        return sseResponse(loadFixture("google/tool-call.txt"));
      },
      async () => {
        await stream(TEST_MODEL, context, {
          apiKey: "test-key",
          parallelToolCalls: false,
        }).result();
      },
    );

    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0] as object)).toEqual(["contents", "tools"]);
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
