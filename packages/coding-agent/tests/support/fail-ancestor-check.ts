// Preloaded into the Coding Agent with `bun --preload`. It replaces src/ancestor-credentials.ts
// with a version whose check always fails with CHECK_FAILED, so a test can see what cli.ts does
// with that failure on every platform. Never import it from a test file: the plugin would apply to
// the test runner itself.
import { plugin } from "bun";

plugin({
  name: "fail-ancestor-check",
  setup(build) {
    build.onLoad({ filter: /[/\\]ancestor-credentials\.ts$/ }, () => ({
      contents:
        "export const checkAncestorCredentials = async () => " +
        '({ ok: false, code: "CHECK_FAILED", message: "forced by the test" });',
      loader: "ts",
    }));
  },
});
