import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";
import {
  type CreateChildProcessLauncherResult,
  createChildProcessLauncher,
} from "@coding-agent/tools";

/** The composition root supplies AI's complete name set without a tools → ai dependency. */
export function createConfiguredChildLauncher(): CreateChildProcessLauncherResult {
  return createChildProcessLauncher(PROVIDER_CREDENTIAL_ENV_VARS);
}
