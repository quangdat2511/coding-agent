// Preloaded into the Coding Agent with `bun --preload`. It replaces src/session-factory.ts with a
// version whose openSession never settles, so the run stays where no Agent Session can take
// `cancel`. Never import it from a test file: the plugin would apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "hang-session-factory",
  setup(build) {
    build.onLoad({ filter: /[/\\]session-factory\.ts$/ }, () => ({
      contents:
        "export const openSession = () => {\n" +
        "  setInterval(() => undefined, 1_000);\n" +
        "  return new Promise(() => undefined);\n" +
        "};\n",
      loader: "ts",
    }));
  },
});
