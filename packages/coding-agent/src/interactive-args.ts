// The options of the interactive path. Like run-args.ts, this decides usage errors before any file
// or environment access: values stay verbatim and run-config.ts resolves them. It has no
// --approval-policy (the interactive path always asks), no --task-file (the person types the
// Coding Task) and no --output-dir or --profile (it writes no files and runs the default Session
// Limits), so ADR 0005 §3's command line for `run` is untouched.
import {
  fail,
  fieldsOf,
  flagTable,
  providers,
  readFlags,
  requireOneOf,
  requireValue,
  type SessionFlags,
  sessionFlagHelp,
  sessionFlagOf,
  type UsageError,
} from "./flags.ts";

export type InteractiveArgs = SessionFlags;

export type ParseInteractiveArgsResult =
  | { readonly ok: true; readonly args: InteractiveArgs }
  | UsageError;

const fieldOf = fieldsOf(sessionFlagOf);

export const INTERACTIVE_USAGE = `usage: coding-agent ${sessionFlagOf.provider} <provider> ${sessionFlagOf.model} <model-id>
                    [${sessionFlagOf.repoRoot} <dir>]

${flagTable([sessionFlagHelp.provider, sessionFlagHelp.model, sessionFlagHelp.repoRoot])}`;

export function parseInteractiveArgs(
  argv: readonly string[],
  cwd: string,
): ParseInteractiveArgsResult {
  const read = readFlags(argv, fieldOf);
  if ("problem" in read) return fail(read.problem);
  const { raw } = read;

  const provider = requireOneOf(sessionFlagOf.provider, raw.provider, providers);
  if (typeof provider !== "string") return fail(provider);
  const model = requireValue(sessionFlagOf.model, raw.model);
  if (typeof model !== "string") return fail(model);

  return { ok: true, args: { provider, model, repoRoot: raw.repoRoot ?? cwd } };
}
