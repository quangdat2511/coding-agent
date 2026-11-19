import { describe, expect, it } from "bun:test";
import {
  type Context,
  createProviderDirectory,
  GOOGLE_GENERATE_CONTENT_CAPABILITIES,
  type Model,
} from "@coding-agent/ai";
import { BUILD_INFO } from "../src/build-info.ts";
import type { ProviderId } from "../src/flags.ts";
import { createModelPort, type ModelPortConfig } from "../src/model-port.ts";
import { hang, replay, withProvider } from "./support/recorded-provider.ts";

const secret = "sk-test-credential-value";

const catalogModel = (provider: ProviderId, id: string): Model => {
  const model = createProviderDirectory().getModel(provider, id);
  if (model === undefined) throw new Error(`the ${provider} catalog lists no ${id}`);
  return model;
};

const configFor = (
  provider: ProviderId,
  id: string,
  overrides: Partial<ModelPortConfig> = {},
): ModelPortConfig => ({
  model: catalogModel(provider, id),
  credential: { variable: "TEST_API_KEY", reveal: () => secret },
  sampling: { maxOutputTokens: null, temperature: null },
  transportRetryBound: 0,
  ...overrides,
});

describe("the model a ModelPort reports", () => {
  it("is the selected model's identity, with that model's declared capabilities", () => {
    const port = createModelPort(configFor("google", "gemini-2.5-flash"));

    expect(port.identity).toEqual({
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "google",
    });
    expect(port.capabilities).toEqual(GOOGLE_GENERATE_CONTENT_CAPABILITIES);
  });
});

const readSchema = { type: "object", required: ["path"], properties: { path: { type: "string" } } };

const request = () => ({ signal: new AbortController().signal, parallelToolCalls: false as const });

// One Model Turn that asked for two reads, one of which failed, as Agent Core records it: each Tool
// Result is a user message of its own.
const context: Context = {
  systemPrompt: "You are a coding agent.",
  messages: [
    { role: "user", content: "Read a.txt and b.txt" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading both." },
        { type: "tool_call", toolCallId: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
        { type: "tool_call", toolCallId: "call_b", name: "read", arguments: '{"path":"b.txt"}' },
      ],
      model: "recorded",
      finishReason: { reason: "tool_call", rawReason: "recorded" },
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "call_a", content: "1 | alpha", isError: false },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call_b",
          content: "b.txt does not exist",
          isError: true,
        },
      ],
    },
  ],
  tools: [{ name: "read", description: "Read a file", parameters: readSchema }],
};

const chatCompletionsRequest = {
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Read a.txt and b.txt" },
    {
      role: "assistant",
      content: "Reading both.",
      tool_calls: [
        {
          id: "call_a",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.txt"}' },
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "read", arguments: '{"path":"b.txt"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "1 | alpha" },
    { role: "tool", tool_call_id: "call_b", content: "b.txt does not exist" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "read", description: "Read a file", parameters: readSchema },
    },
  ],
};

const bearer = ["authorization", `Bearer ${secret}`] as const;

const noParallelToolCalls = { parallel_tool_calls: false } as const;

const providers = [
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    credentialHeader: ["x-api-key", secret],
    disableParallel: { tool_choice: { type: "auto", disable_parallel_tool_use: true } },
    wire: {
      system: "You are a coding agent.",
      messages: [
        { role: "user", content: "Read a.txt and b.txt" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading both." },
            { type: "tool_use", id: "call_a", name: "read", input: { path: "a.txt" } },
            { type: "tool_use", id: "call_b", name: "read", input: { path: "b.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_a", content: "1 | alpha", is_error: false },
            {
              type: "tool_result",
              tool_use_id: "call_b",
              content: "b.txt does not exist",
              is_error: true,
            },
          ],
        },
      ],
      tools: [{ name: "read", description: "Read a file", input_schema: readSchema }],
    },
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    credentialHeader: ["x-goog-api-key", secret],
    disableParallel: null,
    wire: {
      system_instruction: { parts: [{ text: "You are a coding agent." }] },
      contents: [
        { role: "user", parts: [{ text: "Read a.txt and b.txt" }] },
        {
          role: "model",
          parts: [
            { text: "Reading both." },
            { functionCall: { name: "read", args: { path: "a.txt" } } },
            { functionCall: { name: "read", args: { path: "b.txt" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "read", response: { output: "1 | alpha" } } },
            { functionResponse: { name: "read", response: { error: "b.txt does not exist" } } },
          ],
        },
      ],
      tools: [
        {
          function_declarations: [
            { name: "read", description: "Read a file", parameters: readSchema },
          ],
        },
      ],
    },
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    credentialHeader: bearer,
    disableParallel: noParallelToolCalls,
    wire: chatCompletionsRequest,
  },
  {
    provider: "opencode",
    model: "deepseek-v4.1-flash",
    credentialHeader: bearer,
    // Go does not declare parallelToolCallControl, so the request is dropped as for Google.
    disableParallel: null,
    wire: chatCompletionsRequest,
  },
  {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    credentialHeader: bearer,
    disableParallel: noParallelToolCalls,
    wire: chatCompletionsRequest,
  },
  {
    provider: "xai",
    model: "grok-4.3",
    credentialHeader: bearer,
    disableParallel: noParallelToolCalls,
    wire: chatCompletionsRequest,
  },
] as const;

describe("the request a ModelPort sends", () => {
  it.each([...providers])(
    "carries the system prompt, transcript, Tool Declarations and Tool Results to $provider with no loss",
    async ({ provider, model, credentialHeader, wire }) => {
      const port = createModelPort(configFor(provider, model));

      await withProvider(replay(`${provider}/tool-call.txt`), async (sent) => {
        const message = await port.stream(context, request()).result();

        expect(message.finishReason.reason).toBe("tool_call");
        expect(sent).toHaveLength(1);
        expect(sent[0]?.body).toMatchObject(wire);
        expect(sent[0]?.headers.get(credentialHeader[0])).toBe(credentialHeader[1]);
      });
    },
  );
});

const honouringParallelControl = providers.flatMap(({ provider, model, disableParallel }) =>
  disableParallel === null ? [] : [{ provider, model, disableParallel }],
);

describe("the request to disable parallel Tool Calls", () => {
  it.each(honouringParallelControl)(
    "is passed on to $provider",
    async ({ provider, model, disableParallel }) => {
      const port = createModelPort(configFor(provider, model));

      await withProvider(replay(`${provider}/tool-call.txt`), async (sent) => {
        await port.stream(context, request()).result();
        expect(sent[0]?.body).toMatchObject(disableParallel);
      });
    },
  );

  it("is dropped for Google, which cannot honour it", async () => {
    const port = createModelPort(configFor("google", "gemini-2.5-flash"));

    await withProvider(replay("google/tool-call.txt"), async (sent) => {
      await port.stream(context, request()).result();
      expect(Object.keys(sent[0]?.body ?? {}).sort()).toEqual([
        "contents",
        "system_instruction",
        "tools",
      ]);
    });
  });

  it("is dropped for OpenCode Go, which does not declare it", async () => {
    const port = createModelPort(configFor("opencode", "deepseek-v4.1-flash"));

    await withProvider(replay("opencode/tool-call.txt"), async (sent) => {
      await port.stream(context, request()).result();
      expect(sent[0]?.body).not.toHaveProperty("parallel_tool_calls");
    });
  });
});

describe("the user agent a ModelPort sends", () => {
  it.each([...providers])("names the Coding Agent and its version to $provider", async (target) => {
    const port = createModelPort(configFor(target.provider, target.model));

    await withProvider(replay(`${target.provider}/tool-call.txt`), async (sent) => {
      await port.stream(context, request()).result();
      expect(sent[0]?.headers.get("user-agent")).toBe(`coding-agent/${BUILD_INFO.version}`);
    });
  });
});

describe("the OpenCode Go request a ModelPort sends", () => {
  it("goes to the Go gateway with the Coding Agent's version as its user agent", async () => {
    const port = createModelPort(configFor("opencode", "deepseek-v4.1-flash"));

    await withProvider(replay("opencode/tool-call.txt"), async (sent) => {
      await port.stream(context, request()).result();
      expect(sent[0]?.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
      expect(sent[0]?.headers.get("user-agent")).toBe(`coding-agent/${BUILD_INFO.version}`);
      expect(sent[0]?.headers.get("x-opencode-session")).toBeTruthy();
    });
  });

  // ADR 0007 §6: a per-turn id would defeat Go's prompt cache.
  it("keeps one session id for every Model Turn and issues another to the next port", async () => {
    const sessionsOf = async () => {
      const port = createModelPort(configFor("opencode", "deepseek-v4.1-flash"));
      let sessions: (string | null | undefined)[] = [];
      await withProvider(replay("opencode/tool-call.txt"), async (sent) => {
        await port.stream(context, request()).result();
        await port.stream(context, request()).result();
        sessions = sent.map((one) => one.headers.get("x-opencode-session"));
      });
      return sessions;
    };

    const first = await sessionsOf();
    const second = await sessionsOf();
    expect(first).toHaveLength(2);
    expect(first[0]).toBeTruthy();
    expect(first[1]).toBe(first[0]);
    expect(second[0]).not.toBe(first[0]);
  });
});

describe("the sampling settings configuration binds", () => {
  it("cap Anthropic's output tokens and leave its temperature to the provider", async () => {
    const sampling = { maxOutputTokens: 32_000, temperature: null };
    const port = createModelPort(configFor("anthropic", "claude-haiku-4-5", { sampling }));

    await withProvider(replay("anthropic/tool-call.txt"), async (sent) => {
      await port.stream(context, request()).result();
      expect(sent[0]?.body).toHaveProperty("max_tokens", 32_000);
      expect(sent[0]?.body).not.toHaveProperty("temperature");
    });
  });

  it("reach Google's generation config when set", async () => {
    const sampling = { maxOutputTokens: 1_000, temperature: 0.2 };
    const port = createModelPort(configFor("google", "gemini-2.5-flash", { sampling }));

    await withProvider(replay("google/tool-call.txt"), async (sent) => {
      await port.stream(context, request()).result();
      expect(sent[0]?.body).toHaveProperty("generationConfig", {
        temperature: 0.2,
        maxOutputTokens: 1_000,
      });
    });
  });

  it("leave every setting to the provider when none is set", async () => {
    const port = createModelPort(configFor("openai", "gpt-4o-mini"));

    await withProvider(replay("openai/tool-call.txt"), async (sent) => {
      await port.stream(context, request()).result();
      expect(sent[0]?.body).not.toHaveProperty("max_tokens");
      expect(sent[0]?.body).not.toHaveProperty("temperature");
    });
  });
});

describe("the transport retry bound configuration binds", () => {
  it.each([
    [0, 1],
    [2, 3],
  ])(
    "allows %i retries of a request that fails before its stream opens",
    async (bound, attempts) => {
      const port = createModelPort(
        configFor("google", "gemini-2.5-flash", { transportRetryBound: bound }),
      );

      await withProvider(
        () => new Response("unavailable", { status: 503 }),
        async (sent) => {
          await expect(port.stream(context, request()).result()).rejects.toThrow("503");
          expect(sent).toHaveLength(attempts);
        },
      );
    },
  );
});

describe("aborting the signal Agent Core passes", () => {
  it.each([...providers])("ends the $provider stream", async ({ provider, model }) => {
    const port = createModelPort(configFor(provider, model));
    const controller = new AbortController();
    const requested = Promise.withResolvers<void>();

    await withProvider(
      (sent) => {
        requested.resolve();
        return hang(sent);
      },
      async (sent) => {
        const stream = port.stream(context, {
          signal: controller.signal,
          parallelToolCalls: false,
        });
        const events = Array.fromAsync(stream);
        await requested.promise;
        controller.abort();

        expect((await events).map(({ type }) => type)).toEqual(["error"]);
        expect(sent[0]?.signal?.aborted).toBe(true);
      },
    );
  });
});

describe("a model that declares no capabilities", () => {
  it("cannot back a ModelPort", () => {
    const model = { id: "custom", name: "Custom", provider: "google" };

    expect(() => createModelPort(configFor("google", "gemini-2.5-flash", { model }))).toThrow(
      'google model "custom" declares no Model Capabilities',
    );
  });
});
