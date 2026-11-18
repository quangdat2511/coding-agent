// The options of the interactive path. Like run-args.ts, this decides usage errors before any file
// or environment access: values stay verbatim and run-config.ts resolves them. It has no
// --approval-policy (the interactive path always asks), no --task-file (the person types the
// Coding Task) and no --output-dir or --profile (it writes no files and runs the default limits),
// so ADR 0005 §3's command line for `run` is untouched.
import {
  fail,
  flagOf,
  type ParseRunArgsResult,
  type ProviderId,
  providers,
  readFlags,
  requireOneOf,
  requireValue,
} from "./run-args.ts";

export interface InteractiveArgs {
  readonly provider: ProviderId;
  readonly model: string;
  readonly repoRoot: string;
}

export type ParseInteractiveArgsResult =
  | { readonly ok: true; readonly args: InteractiveArgs }
  | Extract<ParseRunArgsResult, { ok: false }>;

const interactiveFlagOf = {
  provider: flagOf.provider,
  model: flagOf.model,
  repoRoot: flagOf.repoRoot,
} as const satisfies Record<keyof InteractiveArgs, `--${string}`>;

const fieldOf = new Map<string, keyof InteractiveArgs>(
  Object.entries(interactiveFlagOf).map(([field, flag]) => [flag, field as keyof InteractiveArgs]),
);

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
  if ("problem" in read) return fail(read.problem) as ParseInteractiveArgsResult;
  const { raw } = read;

  const provider = requireOneOf(interactiveFlagOf.provider, raw.provider, providers);
  if (typeof provider !== "string") return fail(provider) as ParseInteractiveArgsResult;
  const model = requireValue(interactiveFlagOf.model, raw.model);
  if (typeof model !== "string") return fail(model) as ParseInteractiveArgsResult;

  return { ok: true, args: { provider, model, repoRoot: raw.repoRoot ?? cwd } };
}
