// Preloaded into the Coding Agent with `bun --preload`. It replaces src/session-factory.ts with a
// version whose openSession throws with the credential in its message. Never import it from a test
// file: the plugin would apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "fail-session-factory",
  setup(build) {
    build.onLoad({ filter: /[/\\]session-factory\.ts$/ }, () => ({
      contents:
        "export const openSession = async () => {\n" +
        '  throw new Error("forced by the test, key " + process.env.GOOGLE_API_KEY);\n' +
        "};\n",
      loader: "ts",
    }));
  },
});
