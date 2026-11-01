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

export const hang: Respond = ({ signal }) =>
  new Promise((_, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
  });

// Every provider adapter, SDK-backed or not, sends through globalThis.fetch.
export async function withProvider(
  respond: Respond,
  run: (sent: readonly SentRequest[]) => Promise<void>,
): Promise<void> {
  const sent: SentRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
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
    { preconnect: original.preconnect },
  );
  try {
    await run(sent);
  } finally {
    globalThis.fetch = original;
  }
}
