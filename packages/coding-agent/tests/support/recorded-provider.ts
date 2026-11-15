import { join } from "node:path";

export interface SentRequest {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

export type Respond = (request: SentRequest) => Response | Promise<Response>;

const fixturesDir = join(import.meta.dir, "..", "fixtures");

export function replay(fixture: string): Respond {
  return async () =>
    new Response(await Bun.file(join(fixturesDir, fixture)).text(), {
      headers: { "content-type": "text/event-stream" },
    });
}

// Read by replay-provider.ts: the fixtures to replay, in order, separated by commas.
export const REPLAY_FIXTURES_ENV_VAR = "CODING_AGENT_TEST_REPLAY_FIXTURES";

export function replayInOrder(fixtures: readonly string[]): Respond {
  const remaining = [...fixtures];
  return (request) => {
    const next = remaining.shift();
    if (next === undefined) throw new Error("no recorded response is left for this request");
    return replay(next)(request);
  };
}

// A timer clamps Infinity to 1 ms, so a request that never quiesces sets none.
export const hangQuiescingAfter =
  (delayMs: number): Respond =>
  ({ signal }) =>
    new Promise((_, reject) => {
      const abort = () => {
        const settle = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (delayMs === 0) settle();
        else if (Number.isFinite(delayMs)) setTimeout(settle, delayMs);
      };
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
    });

export const hang: Respond = hangQuiescingAfter(0);

// Read by hang-provider.ts: the milliseconds a request takes to quiesce, or "Infinity".
export const HANG_QUIESCE_MS_ENV_VAR = "CODING_AGENT_TEST_HANG_QUIESCE_MS";

export function providerFetch(respond: Respond, sent: SentRequest[] = []): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const raw =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const text = await raw.text();
      const request: SentRequest = {
        headers: raw.headers,
        body: text === "" ? {} : JSON.parse(text),
        signal: init?.signal ?? undefined,
      };
      sent.push(request);
      return respond(request);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
}

// Every provider adapter, SDK-backed or not, sends through globalThis.fetch.
export async function withProvider(
  respond: Respond,
  run: (sent: readonly SentRequest[]) => Promise<void>,
): Promise<void> {
  const sent: SentRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = providerFetch(respond, sent);
  try {
    await run(sent);
  } finally {
    globalThis.fetch = original;
  }
}
