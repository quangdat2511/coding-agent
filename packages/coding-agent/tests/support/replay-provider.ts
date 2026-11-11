// Preloaded into the Coding Agent with `bun --preload`. Never import it from a test file: it would
// replace fetch in the test runner itself.
import { providerFetch, REPLAY_FIXTURES_ENV_VAR, replayInOrder } from "./recorded-provider.ts";

const fixtures = (process.env[REPLAY_FIXTURES_ENV_VAR] ?? "").split(",").filter(Boolean);

globalThis.fetch = providerFetch(replayInOrder(fixtures));
