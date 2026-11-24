// Parses `coding-agent run` (ADR 0005 §3). Its only import is flags.ts, which imports nothing, so
// usage errors are decided before any I/O. Values stay verbatim; resolving paths, reading the task
// file, and checking credentials or models belong in run-config.ts, after the `parsed.ok` check in
// cli.ts.
import {
  type AgentRunFlags,
  agentRunFlagHelp,
  agentRunFlagOf,
  fail,
  fieldsOf,
  flagTable,
  problem,
  providers,
  readFlags,
  requireOneOf,
  requireValue,
  type UsageError,
} from "./flags.ts";

export type Profile = "default" | "terminalbench";

export interface RunArgs extends AgentRunFlags {
  readonly taskFile: string;
  readonly approvalPolicy: "auto-approve";
  readonly outputDir: string;
  readonly profile: Profile;
}

export type ParseRunArgsResult = { readonly ok: true; readonly args: RunArgs } | UsageError;

const profiles = { default: true, terminalbench: true } satisfies Record<Profile, true>;

const approvalPolicies = { "auto-approve": true } satisfies Record<RunArgs["approvalPolicy"], true>;

export const flagOf = {
  ...agentRunFlagOf,
  taskFile: "--task-file",
  approvalPolicy: "--approval-policy",
  outputDir: "--output-dir",
  profile: "--profile",
} as const satisfies Record<keyof RunArgs, `--${string}`>;

const fieldOf = fieldsOf(flagOf);

const command = "run";

export const USAGE = `usage: coding-agent ${command} ${flagOf.taskFile} <path> ${flagOf.provider} <provider>
                    ${flagOf.model} <model-id> ${flagOf.approvalPolicy} auto-approve
                    ${flagOf.outputDir} <dir> [${flagOf.profile} <name>] [${flagOf.repoRoot} <dir>]
       coding-agent --version

${flagTable([
  [`${flagOf.taskFile} <path>`, "required  file whose entire content is the Coding Task objective"],
  agentRunFlagHelp.provider,
  agentRunFlagHelp.model,
  [`${flagOf.approvalPolicy} auto-approve`, 'required  only "auto-approve" is accepted'],
  [`${flagOf.outputDir} <dir>`, "required  directory the run writes its files into"],
  [`${flagOf.profile} <name>`, `optional  ${Object.keys(profiles).join(" | ")} (default: default)`],
  agentRunFlagHelp.repoRoot,
])}`;

export function parseRunArgs(argv: readonly string[], cwd: string): ParseRunArgsResult {
  const [given, ...tokens] = argv;
  // The command line sends an empty argv to the interactive path, so only a direct call gets here.
  if (given === undefined) return fail(problem(undefined, "a command is required"));
  if (given !== command) return fail(problem(undefined, `unknown command "${given}"`));

  const read = readFlags(tokens, fieldOf);
  if ("problem" in read) return fail(read.problem);
  const { raw } = read;

  const taskFile = requireValue(flagOf.taskFile, raw.taskFile);
  if (typeof taskFile !== "string") return fail(taskFile);
  const provider = requireOneOf(flagOf.provider, raw.provider, providers);
  if (typeof provider !== "string") return fail(provider);
  const model = requireValue(flagOf.model, raw.model);
  if (typeof model !== "string") return fail(model);
  const approvalPolicy = requireOneOf(flagOf.approvalPolicy, raw.approvalPolicy, approvalPolicies);
  if (typeof approvalPolicy !== "string") return fail(approvalPolicy);
  const outputDir = requireValue(flagOf.outputDir, raw.outputDir);
  if (typeof outputDir !== "string") return fail(outputDir);
  const profile =
    raw.profile === undefined ? "default" : requireOneOf(flagOf.profile, raw.profile, profiles);
  if (typeof profile !== "string") return fail(profile);

  return {
    ok: true,
    args: {
      taskFile,
      provider,
      model,
      approvalPolicy,
      outputDir,
      profile,
      repoRoot: raw.repoRoot ?? cwd,
    },
  };
}
