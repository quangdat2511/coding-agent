// Preloaded into the Coding Agent with `bun --preload`. Never import it from a test file: it would
// replace fetch in the test runner itself.
import { HANG_QUIESCE_MS_ENV_VAR, hangQuiescingAfter, providerFetch } from "./recorded-provider.ts";

const quiesceMs = Number(process.env[HANG_QUIESCE_MS_ENV_VAR] ?? 0);

globalThis.fetch = providerFetch(hangQuiescingAfter(quiesceMs));
// An effect that never quiesces usually holds the process open, as a socket or a child would.
if (quiesceMs === Number.POSITIVE_INFINITY) setInterval(() => undefined, 1_000);
