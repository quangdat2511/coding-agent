// Preloaded into the Coding Agent with `bun --preload`. It replaces src/non-dumpable.ts with a
// version whose hardening always fails with the message "forced by the test", so a test can see
// what cli.ts does with that failure on every platform. Never import it from a test file: the
// plugin would apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "fail-hardening",
  setup(build) {
    build.onLoad({ filter: /[/\\]non-dumpable\.ts$/ }, () => ({
      contents:
        'export const markProcessNonDumpable = () => ({ ok: false, message: "forced by the test" });',
      loader: "ts",
    }));
  },
});
