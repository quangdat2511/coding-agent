#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Exit 2 means no Agent Session was opened (ADR 0005 §3). Usage errors are decided before any file
// or environment access, and configuration errors before any Agent Session opens; resolving the
// configuration writes only the output directory, and only once every other check has passed.
import { markProcessNonDumpable } from "./non-dumpable.ts";
import { parseRunArgs, USAGE } from "./run-args.ts";
import { resolveRunConfig } from "./run-config.ts";

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
  const resolved = await resolveRunConfig(parsed.args, { cwd, env });
  if (!resolved.ok) {
    process.stderr.write(`coding-agent: ${resolved.message}\n`);
    return resolved.code === "INVALID_CONFIGURATION" ? 2 : 70;
  }
  // Temporary: CDA-67 (Join 2) opens the Agent Session from this configuration, with the system
  // prompt from assembleSystemPrompt and exit 2 when that fails, CDA-75 (D3.1) returns exit codes 0
  // and 1, and CDA-78 (D3.2) returns 130. Until then a valid run has nothing to run.
  process.stderr.write(
    "coding-agent: run is not implemented yet; the Agent Session lands in CDA-67 (Join 2)\n",
  );
  return 70;
}

// CDA-75 (D3.1), CDA-78 (D3.2): set `process.exitCode`, since `process.exit()` can truncate piped
// stderr, and keep the 70 fallback, since an uncaught throw exits 1, a failed Agent Result.
try {
  process.exitCode = await main(process.argv.slice(2), process.cwd(), process.env);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`coding-agent: internal error: ${reason}\n`);
  process.exitCode = 70;
}
