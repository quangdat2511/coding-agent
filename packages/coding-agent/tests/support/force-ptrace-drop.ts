// Preloaded into the Coding Agent with `bun --preload`. It replaces src/ptrace-capability.ts with a
// version whose dropPtraceCapability returns the result that FORCED_PTRACE_DROP holds as JSON, so a
// test can see what cli.ts does with each result on every platform. Never import it from a test
// file: the plugin would apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "force-ptrace-drop",
  setup(build) {
    build.onLoad({ filter: /[/\\]ptrace-capability\.ts$/ }, () => ({
      contents:
        "export const dropPtraceCapability = () => JSON.parse(process.env.FORCED_PTRACE_DROP ?? '{\"ok\":true}');",
      loader: "ts",
    }));
  },
});
