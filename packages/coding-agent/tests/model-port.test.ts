import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  type Context,
  createProviderDirectory,
  GOOGLE_GENERATE_CONTENT_CAPABILITIES,
  type Model,
  type ModelCapabilities,
  type ModelStreamEvent,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
  type ToolDeclaration,
  XAI_CHAT_COMPLETIONS_CAPABILITIES,
} from "@coding-agent/ai";
import { createModelPort, type ModelSettings } from "../src/model-port.ts";
import type { ResolvedCredential } from "../src/run-config.ts";

// The recorded tool-call fixtures of packages/ai/tests/fixtures, copied because a test may not
// import across packages. Each one answers with a single get_weather call for Tokyo.
const fixture = (provider: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", provider, "tool-call.txt"), "utf-8");

const sse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/event-stream" } });

interface SentRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

// Replaces fetch below the SDK clients, so the port and the whole `ai` adapter run with no live call.
// Every call is recorded, even one whose signal has already aborted.
function interceptFetch(respond: (attempt: number, signal: AbortSignal) => Response) {
  const sent: SentRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push({
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: (await request.json()) as Record<string, unknown>,
    });
    if (request.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return respond(sent.length, request.signal);
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return sent;
}

let restore = (): void => {};
afterEach(() => restore());

const providers = createProviderDirectory();

const catalogModel = (provider: string, id: string): Model => {
  const model = providers.getModel(provider, id);
  if (model === undefined) throw new Error(`the catalog has no ${provider} model ${id}`);
  return model;
};

const credential = (value: string): ResolvedCredential => ({
  variable: "TEST_API_KEY",
  reveal: () => value,
});

const providerDefaults: ModelSettings = { sampling: {}, transportRetryBound: 0 };

const readTool: ToolDeclaration = {
  name: "read",
  description: "Read a file below the repository root",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  } as unknown as ToolDeclaration["parameters"],
};

// A second Model Turn: the transcript holds a Tool Call and its Tool Result.
const secondTurn: Context = {
  systemPrompt: "You are a coding agent.",
  tools: [readTool],
  messages: [
    { role: "user", content: "What does a.ts export?" },
    {
      role: "assistant",
      model: "recorded",
      finishReason: { reason: "tool_call", rawReason: "recorded" },
      content: [
        { type: "tool_call", toolCallId: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call_1",
          content: "export const a = 1;",
          isError: false,
        },
      ],
    },
  ],
};

const recordedCall = {
  type: "tool_call",
  name: "get_weather",
  arguments: '{"city":"Tokyo"}',
};

interface ProviderCase {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  readonly credentialHeader: (key: string) => Readonly<Record<string, string>>;
  // What disabling parallel Tool Calls looks like on the wire, or undefined where the API has no
  // such control.
  readonly parallelRequest: Readonly<Record<string, unknown>> | undefined;
}

const cases: readonly ProviderCase[] = [
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    capabilities: ANTHROPIC_MESSAGES_CAPABILITIES,
    credentialHeader: (key) => ({ "x-api-key": key }),
    parallelRequest: { tool_choice: { type: "auto", disable_parallel_tool_use: true } },
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    capabilities: GOOGLE_GENERATE_CONTENT_CAPABILITIES,
    credentialHeader: (key) => ({ "x-goog-api-key": key }),
    parallelRequest: undefined,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    capabilities: OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
    credentialHeader: (key) => ({ authorization: `Bearer ${key}` }),
    parallelRequest: { parallel_tool_calls: false },
  },
  {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    capabilities: OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
    credentialHeader: (key) => ({ authorization: `Bearer ${key}` }),
    parallelRequest: { parallel_tool_calls: false },
  },
  {
    provider: "xai",
    model: "grok-4.3",
    capabilities: XAI_CHAT_COMPLETIONS_CAPABILITIES,
    credentialHeader: (key) => ({ authorization: `Bearer ${key}` }),
    parallelRequest: { parallel_tool_calls: false },
  },
];

describe.each([...cases])("a ModelPort over $provider", (providerCase) => {
  const model = catalogModel(providerCase.provider, providerCase.model);
  const port = () =>
    createModelPort({
      providers,
      model,
      credential: credential("sk-test-1"),
      settings: providerDefaults,
    });

  it("exposes the model identity and the capabilities its API declares", () => {
    expect(port().identity).toEqual({
      id: providerCase.model,
      name: model.name,
      provider: providerCase.provider,
    });
    expect(port().capabilities).toEqual(providerCase.capabilities);
  });

  it("streams a second Model Turn with its Tool Result and returns the recorded reply", async () => {
    const sent = interceptFetch(() => sse(fixture(providerCase.provider)));

    const reply = await port()
      .stream(secondTurn, { signal: new AbortController().signal, parallelToolCalls: false })
      .result();

    expect(reply.content).toEqual([expect.objectContaining(recordedCall)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers).toMatchObject(providerCase.credentialHeader("sk-test-1"));
    const wire = JSON.stringify(sent[0]?.body);
    expect(wire).toContain("You are a coding agent.");
    expect(wire).toContain("Read a file below the repository root");
    expect(wire).toContain("export const a = 1;");
  });

  it("passes the request to disable parallel Tool Calls on where the API supports it", async () => {
    const sent = interceptFetch(() => sse(fixture(providerCase.provider)));

    await port()
      .stream(secondTurn, { signal: new AbortController().signal, parallelToolCalls: false })
      .result();

    if (providerCase.parallelRequest === undefined) {
      for (const field of ["tool_choice", "parallel_tool_calls", "toolConfig", "tool_config"]) {
        expect(sent[0]?.body).not.toHaveProperty(field);
      }
    } else {
      expect(sent[0]?.body).toMatchObject(providerCase.parallelRequest);
    }
  });

  it("stops before any request goes out when the signal is already aborted", async () => {
    const sent = interceptFetch(() => sse(fixture(providerCase.provider)));
    const controller = new AbortController();
    controller.abort();

    const events: ModelStreamEvent[] = [];
    const stream = port().stream(secondTurn, {
      signal: controller.signal,
      parallelToolCalls: false,
    });
    for await (const event of stream) events.push(event);

    expect(events.map(({ type }) => type)).toEqual(["error"]);
    await expect(stream.result()).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("ends the stream with an error when the signal aborts after the response opens", async () => {
    // The first event of the recorded reply, then a body that stays open until the request aborts.
    const opening = `${fixture(providerCase.provider).split("\n\n")[0]}\n\n`;
    interceptFetch(
      (_attempt, signal) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(body) {
              body.enqueue(new TextEncoder().encode(opening));
              signal.addEventListener("abort", () =>
                body.error(new DOMException("The operation was aborted.", "AbortError")),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const controller = new AbortController();

    const events: ModelStreamEvent[] = [];
    const stream = port().stream(secondTurn, {
      signal: controller.signal,
      parallelToolCalls: false,
    });
    for await (const event of stream) {
      events.push(event);
      if (event.type === "stream_start") controller.abort();
    }

    expect(events[0]?.type).toBe("stream_start");
    expect(events.at(-1)?.type).toBe("error");
    await expect(stream.result()).rejects.toThrow();
  });
});

describe("binding configuration into a ModelPort", () => {
  it("follows the declared capability, not the provider, when parallel Tool Calls cannot be disabled", async () => {
    const anthropic = catalogModel("anthropic", "claude-haiku-4-5");
    const sent = interceptFetch(() => sse(fixture("anthropic")));
    const port = createModelPort({
      providers,
      model: {
        ...anthropic,
        capabilities: { ...ANTHROPIC_MESSAGES_CAPABILITIES, parallelToolCallControl: false },
      },
      credential: credential("sk-test-1"),
      settings: providerDefaults,
    });

    await port
      .stream(secondTurn, { signal: new AbortController().signal, parallelToolCalls: false })
      .result();

    expect(sent[0]?.body).not.toHaveProperty("tool_choice");
  });

  it("sends the configured sampling settings with every request", async () => {
    const sent = interceptFetch(() => sse(fixture("google")));
    const port = createModelPort({
      providers,
      model: catalogModel("google", "gemini-2.5-flash"),
      credential: credential("sk-test-1"),
      settings: { sampling: { temperature: 0.2, maxTokens: 2048 }, transportRetryBound: 0 },
    });

    await port
      .stream(secondTurn, { signal: new AbortController().signal, parallelToolCalls: false })
      .result();

    expect(sent[0]?.body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 2048 });
  });

  it("re-sends a request that fails before its stream opens up to the transport retry bound", async () => {
    const sent = interceptFetch(() => sse("", 503));
    const port = createModelPort({
      providers,
      model: catalogModel("google", "gemini-2.5-flash"),
      credential: credential("sk-test-1"),
      settings: { sampling: {}, transportRetryBound: 2 },
    });

    const reply = port
      .stream(secondTurn, { signal: new AbortController().signal, parallelToolCalls: false })
      .result();

    await expect(reply).rejects.toThrow("503");
    expect(sent).toHaveLength(3);
  });

  it("refuses a model that declares no capabilities", () => {
    const { capabilities: _, ...undeclared } = catalogModel("google", "gemini-2.5-flash");

    expect(() =>
      createModelPort({
        providers,
        model: undeclared,
        credential: credential("sk-test-1"),
        settings: providerDefaults,
      }),
    ).toThrow('google model "gemini-2.5-flash" declares no capabilities');
  });
});
