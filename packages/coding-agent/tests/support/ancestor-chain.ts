// The test runner is itself an ancestor of every Coding Agent it starts. If the shell that started
// it exported a provider key, the ancestor check rightly refuses every run under "auto-approve" on
// Linux, so a test that needs a run to get past the check cannot pass and is skipped. A .env file
// does not count: Bun loads it into process.env, which does not change /proc/self/environ.
import { readFileSync } from "node:fs";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";
import { checkAncestorCredentials, heldCredential } from "../../src/ancestor-credentials.ts";
import { onLinux } from "./platform.ts";

// True when a run that the test runner starts gets past the ancestor check. The check does not run
// on other platforms, so there it is always true.
export async function runnerChainIsClean(): Promise<boolean> {
  if (!onLinux) return true;
  const own = heldCredential(
    readFileSync("/proc/self/environ", "utf8"),
    new Set(PROVIDER_CREDENTIAL_ENV_VARS),
  );
  return own === undefined && (await checkAncestorCredentials("auto-approve")).ok;
}
