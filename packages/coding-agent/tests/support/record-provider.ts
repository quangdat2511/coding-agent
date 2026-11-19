// Preloaded into the Coding Agent with `bun --preload` for a live run that records fixtures. It
// sends each request to the real provider and writes each successful response body, in order, to
// turn-<n>.txt in the directory that CODING_AGENT_TEST_RECORD_DIR names, which replay-provider.ts
// then answers with. Never import it from a test file: it would replace fetch in the test runner.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";

const recordDir = process.env.CODING_AGENT_TEST_RECORD_DIR;
if (recordDir === undefined || recordDir === "") {
  throw new Error("CODING_AGENT_TEST_RECORD_DIR is not set");
}
mkdirSync(recordDir, { recursive: true });

const credentials = PROVIDER_CREDENTIAL_ENV_VARS.flatMap((name) => {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? [] : [value];
});

const original = globalThis.fetch;
let turn = 0;

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const response = await original(input, init);
    // A transport retry follows a refused request, and replay answers each request with a 200.
    if (!response.ok) return response;
    const body = await response.text();
    if (credentials.some((credential) => body.includes(credential))) {
      throw new Error("a response carries a provider credential, so it was not recorded");
    }
    turn += 1;
    // Git stores fixtures with LF endings (.gitattributes), so write what CI will replay.
    writeFileSync(join(recordDir, `turn-${turn}.txt`), body.replaceAll("\r\n", "\n"));
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "text/event-stream" },
    });
  },
  { preconnect: original.preconnect },
);
