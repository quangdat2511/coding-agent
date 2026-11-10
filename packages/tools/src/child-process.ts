import type { CreateChildEnvironmentResult } from "./child-environment.ts";
import { createChildEnvironmentBuilder } from "./child-environment.ts";

export interface ChildLaunchOptions {
  readonly cwd?: string;
}

export type ChildProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

export interface ChildProcessLauncher {
  launch(command: readonly string[], options?: ChildLaunchOptions): ChildProcess;
}

export type CreateChildProcessLauncherResult =
  | { readonly ok: true; readonly launcher: ChildProcessLauncher }
  | Extract<CreateChildEnvironmentResult, { ok: false }>;

/** The only process launch point in tools; callers cannot replace the child environment. */
export function createChildProcessLauncher(
  credentialEnvVars: readonly string[],
): CreateChildProcessLauncherResult {
  const configured = createChildEnvironmentBuilder(credentialEnvVars);
  if (!configured.ok) return configured;

  return {
    ok: true,
    launcher: {
      launch: (command, options) => {
        const parent = { ...process.env };
        // A Windows object can contain differently cased keys for the same variable. Remove
        // execution-mode aliases before setting the canonical names, so their precedence is clear.
        for (const key of Object.keys(parent)) {
          const name = process.platform === "win32" ? key.toUpperCase() : key;
          if (name === "CI" || name === "TERM") delete parent[key];
        }
        return Bun.spawn([...command], {
          cwd: options?.cwd,
          env: configured.build({ ...parent, CI: "1", TERM: "dumb" }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      },
    },
  };
}
