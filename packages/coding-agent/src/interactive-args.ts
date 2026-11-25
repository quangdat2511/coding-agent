// The options of the interactive path. Like run-args.ts, this decides usage errors before any file
// or environment access: values stay verbatim and run-config.ts resolves them. It has no
// --approval-policy (the interactive path always asks), no --task-file (the person types the
// Coding Task) and no --output-dir or --profile (it writes no files and runs the default Run
// Limits), so ADR 0005 §3's command line for `run` is untouched.
import {
  type AgentRunFlags,
  agentRunFlagHelp,
  agentRunFlagOf,
  fail,
  fieldsOf,
  flagTable,
  providers,
  readFlags,
  requireOneOf,
  requireValue,
  type UsageError,
} from "./flags.ts";

export type InteractiveArgs = AgentRunFlags & { readonly approvalPolicy: "ask" };

export type ParseInteractiveArgsResult =
  | { readonly ok: true; readonly args: InteractiveArgs }
  | UsageError;

const fieldOf = fieldsOf(agentRunFlagOf);

export const INTERACTIVE_USAGE = `usage: coding-agent ${agentRunFlagOf.provider} <provider> ${agentRunFlagOf.model} <model-id>
                    [${agentRunFlagOf.repoRoot} <dir>]

${flagTable([agentRunFlagHelp.provider, agentRunFlagHelp.model, agentRunFlagHelp.repoRoot])}`;

export function parseInteractiveArgs(
  argv: readonly string[],
  cwd: string,
): ParseInteractiveArgsResult {
  const read = readFlags(argv, fieldOf);
  if ("problem" in read) return fail(read.problem);
  const { raw } = read;

  const provider = requireOneOf(agentRunFlagOf.provider, raw.provider, providers);
  if (typeof provider !== "string") return fail(provider);
  const model = requireValue(agentRunFlagOf.model, raw.model);
  if (typeof model !== "string") return fail(model);

  return {
    ok: true,
    args: { provider, model, repoRoot: raw.repoRoot ?? cwd, approvalPolicy: "ask" },
  };
}
