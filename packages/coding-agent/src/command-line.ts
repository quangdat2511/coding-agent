// Chooses between the two entry points from the first word of the command line (ADR 0004 §6): a
// line that starts with a flag, or is empty, is the interactive path, and any word is a command
// that parseRunArgs accepts or refuses by name. `--version` is handled before this, in cli.ts.

import type { UsageError } from "./flags.ts";
import {
  INTERACTIVE_USAGE,
  type InteractiveArgs,
  parseInteractiveArgs,
} from "./interactive-args.ts";
import { parseRunArgs, type RunArgs, USAGE } from "./run-args.ts";

export type ParseCommandLineResult =
  | { readonly ok: true; readonly command: "run"; readonly args: RunArgs }
  | { readonly ok: true; readonly command: "interactive"; readonly args: InteractiveArgs }
  | UsageError;

export const COMMAND_LINE_USAGE = `${INTERACTIVE_USAGE}\n\n${USAGE}`;

export function parseCommandLine(argv: readonly string[], cwd: string): ParseCommandLineResult {
  const [first] = argv;
  if (first === undefined || first.startsWith("-")) {
    const parsed = parseInteractiveArgs(argv, cwd);
    return parsed.ok ? { ok: true, command: "interactive", args: parsed.args } : parsed;
  }
  const parsed = parseRunArgs(argv, cwd);
  return parsed.ok ? { ok: true, command: "run", args: parsed.args } : parsed;
}
