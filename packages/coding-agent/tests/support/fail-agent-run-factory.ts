// Preloaded into the Coding Agent with `bun --preload`. It replaces src/agent-run-factory.ts with a
// version whose openRun throws with the credential in its message. Never import it from a test
// file: the plugin would apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "fail-agent-run-factory",
  setup(build) {
    build.onLoad({ filter: /[/\\]agent-run-factory\.ts$/ }, () => ({
      contents:
        "export const openRun = async () => {\n" +
        '  throw new Error("forced by the test, key " + process.env.GOOGLE_API_KEY);\n' +
        "};\n",
      loader: "ts",
    }));
  },
});
