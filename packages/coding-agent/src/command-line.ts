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

// The usage to print with the error: a line that starts with `run` gets the usage of `run`, any
// other the usage of both entry points, since the person may have meant either.
export type CommandLineError = UsageError & { readonly usage: string };

export type ParseCommandLineResult =
  | { readonly ok: true; readonly command: "run"; readonly args: RunArgs }
  | { readonly ok: true; readonly command: "interactive"; readonly args: InteractiveArgs }
  | CommandLineError;

export const COMMAND_LINE_USAGE = `${INTERACTIVE_USAGE}\n\n${USAGE}`;

export function parseCommandLine(argv: readonly string[], cwd: string): ParseCommandLineResult {
  const [first] = argv;
  if (first === undefined || first.startsWith("-")) {
    const parsed = parseInteractiveArgs(argv, cwd);
    return parsed.ok
      ? { ok: true, command: "interactive", args: parsed.args }
      : { ...parsed, usage: COMMAND_LINE_USAGE };
  }
  const parsed = parseRunArgs(argv, cwd);
  if (parsed.ok) return { ok: true, command: "run", args: parsed.args };
  return { ...parsed, usage: first === "run" ? USAGE : COMMAND_LINE_USAGE };
}
