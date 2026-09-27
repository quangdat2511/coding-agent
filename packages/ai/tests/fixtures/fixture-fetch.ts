/**
 * Transport-level fetch interceptor for recorded-fixture replay.
 *
 * Replaces `globalThis.fetch` for the duration of a test so that the
 * Anthropic SDK and OpenAI SDK (both of which delegate to
 * `globalThis.fetch` rather than capturing it at module load) exercise
 * the full adapter path against a committed SSE fixture instead of a
 * live provider.
 *
 * The interceptor is installed and restored with `withFixtureFetch()`.
 * Tests that need fine-grained control over connection-phase behaviour
 * (abort before stream opens, network error) can pass a custom
 * `FetchOverride` instead of a fixture file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Directory that contains all committed fixture files. */
const FIXTURES_DIR = import.meta.dir;

/**
 * Reads a committed SSE fixture file and returns its raw text.
 *
 * @param relativePath - Path relative to `tests/fixtures/`, e.g.
 *   `"anthropic/text-streaming.txt"`.
 */
export function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_DIR, relativePath), "utf-8");
}

/**
 * Builds a `Response` whose body streams the provided SSE text
 * line-by-line with a Content-Type of `text/event-stream`.
 *
 * The body is a `ReadableStream` that yields each line encoded as UTF-8,
 * so both the Anthropic and OpenAI SDKs receive a realistic streaming
 * response without a network connection.
 */
export function sseResponse(
  sseText: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const lines = sseText.split("\n");

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...headers,
    },
  });
}

/**
 * A function that, given a `Request`, returns a `Response` (or a
 * `Promise<Response>`). Passed to `withFixtureFetch()` when the test
 * needs custom connection-phase behaviour (e.g. abort, network error,
 * conditional replay).
 */
export type FetchOverride = (request: Request) => Response | Promise<Response>;

/**
 * Installs a fetch override on `globalThis` for the duration of `fn`,
 * then restores the original `globalThis.fetch`.
 *
 * **Usage — fixture file:**
 * ```ts
 * await withFixtureFetch(sseResponse(loadFixture("anthropic/text-streaming.txt")), async () => {
 *   const result = await stream(model, context, { apiKey: "test-key" }).result();
 *   expect(result.content).toEqual([{ type: "text", text: "Hello, world!" }]);
 * });
 * ```
 *
 * **Usage — custom override:**
 * ```ts
 * const controller = new AbortController();
 * await withFixtureFetch((_req) => { controller.abort(); throw new DOMException("aborted", "AbortError"); }, async () => {
 *   // ...
 * });
 * ```
 */
export async function withFixtureFetch(
  responseOrOverride: Response | FetchOverride,
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;

  // Support both a pre-built Response and a function. When a Response is
  // passed it is used for every request (there is only ever one per stream).
  const override: FetchOverride =
    typeof responseOrOverride === "function" ? responseOrOverride : (_req) => responseOrOverride;

  // biome-ignore lint/suspicious/noExplicitAny: intentional fetch override for test interceptor
  (globalThis as any).fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input as string, init);
    return Promise.resolve(override(request));
  };

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Records which URLs and request bodies the intercepted fetch was called with.
 * Useful for asserting retry behaviour: the request is made once, twice, etc.
 */
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Like `withFixtureFetch`, but also captures every request that reaches the
 * interceptor. Useful for asserting retry-before-stream and abort behaviour.
 */
export async function withCapturingFixtureFetch(
  responseOrOverride: Response | FetchOverride,
  fn: (captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  const override: FetchOverride =
    typeof responseOrOverride === "function" ? responseOrOverride : (_req) => responseOrOverride;

  // biome-ignore lint/suspicious/noExplicitAny: intentional fetch override for test interceptor
  (globalThis as any).fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input as string, init);

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({ url: request.url, method: request.method, headers });

    return Promise.resolve(override(request));
  };

  try {
    await fn(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
