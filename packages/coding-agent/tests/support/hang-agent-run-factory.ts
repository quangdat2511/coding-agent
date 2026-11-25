// Preloaded into the Coding Agent with `bun --preload`. It replaces src/agent-run-factory.ts with a
// version whose openRun never settles, so the run stays where no Agent Run can take
// `cancel`. Never import it from a test file: the plugin would apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "hang-agent-run-factory",
  setup(build) {
    build.onLoad({ filter: /[/\\]agent-run-factory\.ts$/ }, () => ({
      contents:
        "export const openRun = () => {\n" +
        "  setInterval(() => undefined, 1_000);\n" +
        "  return new Promise(() => undefined);\n" +
        "};\n",
      loader: "ts",
    }));
  },
});
