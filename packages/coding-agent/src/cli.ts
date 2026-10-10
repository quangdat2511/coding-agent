#!/usr/bin/env bun
// The `coding-agent` executable (ADR 0004 §6). ADR 0005 §3 makes exit 2 an invalid invocation
// with no Agent Session opened and nothing written, so nothing above the `parsed.ok` check may
// touch the filesystem, the environment, or Agent Core. CDA-59 (D1.2) must preserve that ordering
// when it adds configuration resolution here.
import { parseRunArgs, USAGE } from "./run-args.ts";

function main(argv: readonly string[], cwd: string): number {
  const parsed = parseRunArgs(argv, cwd);
  if (!parsed.ok) {
    process.stderr.write(`coding-agent: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  // Temporary: CDA-59 (D1.2) resolves the configuration and CDA-75 (D3.1) returns the real
  // exit codes 0, 1 and 130. Until then a valid invocation has nothing to run.
  process.stderr.write(
    "coding-agent: run is not implemented yet; configuration resolution and the Agent Session " +
      "land in CDA-59 (D1.2)\n",
  );
  return 70;
}

// `process.exitCode` rather than `process.exit()`: exiting outright can truncate a buffered
// stderr write to a pipe, which is exactly what the smoke tests read.
process.exitCode = main(process.argv.slice(2), process.cwd());
