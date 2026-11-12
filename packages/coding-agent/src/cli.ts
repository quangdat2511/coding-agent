#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Exit 2 means no Agent Session was opened (ADR 0005 §3). Usage errors are decided before any file
// or environment access, and configuration errors before any Agent Session opens; a run that opens
// none removes the output directory it created.
import { createConfiguredChildLauncher } from "./child-launcher.ts";
import { runHeadless } from "./headless.ts";
import { markProcessNonDumpable } from "./non-dumpable.ts";
import { parseRunArgs, USAGE } from "./run-args.ts";

async function main(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const parsed = parseRunArgs(argv, cwd);
  if (!parsed.ok) {
    process.stderr.write(`coding-agent: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  // ADR 0001 §8 rule 2. Keep this right after argument parsing, so a usage error still exits 2
  // before any I/O, and ahead of configuration and command dispatch, so that it precedes every
  // Tool Call and Verification child on both entry points and under both Approval Policies. The
  // modules imported above run before main, so they must not start a child when they load.
  const hardened = markProcessNonDumpable();
  if (!hardened.ok) {
    process.stderr.write(
      `coding-agent: cannot mark the process non-dumpable, so no child can be started safely: ${hardened.message}\n`,
    );
    return 70;
  }
  const children = createConfiguredChildLauncher();
  if (!children.ok) {
    process.stderr.write(`coding-agent: ${children.message}\n`);
    return 2;
  }
  // CDA-71 and CDA-74 will receive children.launcher when their adapters are registered.
  // Creating it validates configuration without spawning a process.
  // Bun reports a write to a closed pipe as an "error" event, which would end the run with exit 1.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  // Temporary: CDA-75 (D3.1) writes the run's files, and CDA-78 (D3.2) cancels on a signal.
  const { exitCode } = await runHeadless({
    args: parsed.args,
    cwd,
    env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  return exitCode;
}

// Set `process.exitCode`, since `process.exit()` can truncate piped output, and keep the 70
// fallback, since an uncaught throw exits 1, a failed Agent Result.
try {
  process.exitCode = await main(process.argv.slice(2), process.cwd(), process.env);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`coding-agent: internal error: ${reason}\n`);
  process.exitCode = 70;
}
