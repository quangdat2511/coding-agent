#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// CDA-59 (D1.2): exit 2 means no Agent Session was opened and nothing was written (ADR 0005 §3),
// so keep every file, environment, and Agent Core access below the `parsed.ok` check.
import { parseRunArgs, USAGE } from "./run-args.ts";

function main(argv: readonly string[], cwd: string): number {
  const parsed = parseRunArgs(argv, cwd);
  if (!parsed.ok) {
    process.stderr.write(`coding-agent: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  // Temporary: CDA-59 (D1.2) resolves the configuration, CDA-75 (D3.1) returns exit codes 0 and 1,
  // and CDA-78 (D3.2) returns 130. Until then a valid invocation has nothing to run.
  process.stderr.write(
    "coding-agent: run is not implemented yet; configuration resolution and the Agent Session " +
      "land in CDA-59 (D1.2)\n",
  );
  return 70;
}

// CDA-75 (D3.1), CDA-78 (D3.2): set `process.exitCode`, since `process.exit()` can truncate piped
// stderr, and keep the 70 fallback, since an uncaught throw exits 1, a failed Agent Result.
try {
  process.exitCode = main(process.argv.slice(2), process.cwd());
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`coding-agent: internal error: ${reason}\n`);
  process.exitCode = 70;
}
