// The options of the interactive path. Like run-args.ts, this decides usage errors before any file
// or environment access: values stay verbatim and run-config.ts resolves them. It has no
// --approval-policy (the interactive path always asks), no --task-file (the person types the
// Coding Task) and no --output-dir or --profile (it writes no files and runs the default limits),
// so ADR 0005 §3's command line for `run` is untouched.
import {
  fail,
  fieldsOf,
  type ProviderId,
  providers,
  readFlags,
  requireOneOf,
  requireValue,
  type UsageError,
} from "./flags.ts";
import { flagOf } from "./run-args.ts";

export interface InteractiveArgs {
  readonly provider: ProviderId;
  readonly model: string;
  readonly repoRoot: string;
}

export type ParseInteractiveArgsResult =
  | { readonly ok: true; readonly args: InteractiveArgs }
  | UsageError;

const interactiveFlagOf = {
  provider: flagOf.provider,
  model: flagOf.model,
  repoRoot: flagOf.repoRoot,
} as const satisfies Record<keyof InteractiveArgs, `--${string}`>;

const fieldOf = fieldsOf(interactiveFlagOf);

export const INTERACTIVE_USAGE = `usage: coding-agent ${interactiveFlagOf.provider} <provider> ${interactiveFlagOf.model} <model-id>
                    [${interactiveFlagOf.repoRoot} <dir>]

  ${interactiveFlagOf.provider} <provider>  required  ${Object.keys(providers).join(" | ")}
  ${interactiveFlagOf.model} <model-id>     required  model identifier within that provider
  ${interactiveFlagOf.repoRoot} <dir>      optional  defaults to the working directory`;

export function parseInteractiveArgs(
  argv: readonly string[],
  cwd: string,
): ParseInteractiveArgsResult {
  const read = readFlags(argv, fieldOf);
  if ("problem" in read) return fail(read.problem);
  const { raw } = read;

  const provider = requireOneOf(interactiveFlagOf.provider, raw.provider, providers);
  if (typeof provider !== "string") return fail(provider);
  const model = requireValue(interactiveFlagOf.model, raw.model);
  if (typeof model !== "string") return fail(model);

  return { ok: true, args: { provider, model, repoRoot: raw.repoRoot ?? cwd } };
}
