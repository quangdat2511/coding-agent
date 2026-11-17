import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "./utils/env.ts";

// Records raw SSE bodies from the OpenCode Go gateway into tests/fixtures/opencode/.
// It calls the gateway directly rather than through the provider adapter, so a recording does not
// depend on the code the fixture is meant to test. The request body matches what
// packages/ai/src/api/openai-responses.ts sends.
// Usage: bun packages/ai/examples/opencode-record-fixtures.ts [model-id]

const BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const OUT_DIR = join(import.meta.dir, "..", "tests", "fixtures", "opencode");

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "The city name" } },
      required: ["city"],
    },
  },
};

interface Recording {
  readonly file: string;
  readonly body: Record<string, unknown>;
}

function recordings(model: string): Recording[] {
  const base = { model, stream: true, stream_options: { include_usage: true } };
  return [
    {
      file: "text-streaming.txt",
      body: { ...base, messages: [{ role: "user", content: "Say hello in one short sentence." }] },
    },
    {
      file: "tool-call.txt",
      body: {
        ...base,
        messages: [
          {
            role: "user",
            content: "What is the weather in Tokyo right now? Call get_weather to check.",
          },
        ],
        tools: [weatherTool],
      },
    },
    {
      // A tiny cap forces finish_reason "length".
      file: "finish-reason-length.txt",
      body: {
        ...base,
        max_tokens: 16,
        messages: [{ role: "user", content: "Write a long story about a dragon." }],
      },
    },
    {
      file: "usage-totals.txt",
      body: { ...base, messages: [{ role: "user", content: "Reply with the single word: ok" }] },
    },
  ];
}

async function main(): Promise<void> {
  loadRootEnv();
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");

  const model = process.argv[2] ?? "deepseek-v4.1-flash";
  mkdirSync(OUT_DIR, { recursive: true });

  for (const { file, body } of recordings(model)) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-opencode-session": `record-${crypto.randomUUID()}`,
        "user-agent": "coding-agent/record-fixtures",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${file}: HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    writeFileSync(join(OUT_DIR, file), text);
    console.log(`recorded ${file} (${text.length} bytes)`);
  }
}

main().catch((err) => {
  console.error("Recording failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
