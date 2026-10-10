/**
 * Parses the `coding-agent run` command line pinned by ADR 0005 §3.
 *
 * This module is pure and imports nothing: a usage error must be decided before anything reads
 * the filesystem, the environment, or opens an Agent Session. Values are carried verbatim: no
 * path is resolved, no file is read, no credential is looked up, and no model is checked against
 * its provider. Resolving a valid invocation into session configuration is CDA-59 (D1.2).
 */

export type ProviderId = "anthropic" | "openrouter" | "openai" | "google" | "xai";

export type Profile = "default" | "terminalbench";

/** A `coding-agent run` invocation whose shape ADR 0005 §3 accepts. */
export interface RunArgs {
  readonly taskFile: string;
  readonly provider: ProviderId;
  readonly model: string;
  /**
   * ADR 0005 §3 accepts exactly one value. The literal type carries that rule forward, so the
   * headless path cannot be handed `"ask"` by accident (ADR 0001 §4).
   */
  readonly approvalPolicy: "auto-approve";
  readonly outputDir: string;
  readonly profile: Profile;
  readonly repoRoot: string;
}

export type ParseRunArgsResult =
  | { readonly ok: true; readonly args: RunArgs }
  | {
      readonly ok: false;
      readonly code: "USAGE_ERROR";
      readonly message: string;
      readonly flag?: string;
    };

type UsageProblem = Pick<Extract<ParseRunArgsResult, { ok: false }>, "flag" | "message">;

const providers = {
  anthropic: true,
  openrouter: true,
  openai: true,
  google: true,
  xai: true,
} satisfies Record<ProviderId, true>;

const profiles = { default: true, terminalbench: true } satisfies Record<Profile, true>;

const approvalPolicies = { "auto-approve": true } satisfies Record<RunArgs["approvalPolicy"], true>;

/** The single source of flag spellings. Keyed by field, so a field without a flag is a type error. */
const flagOf = {
  taskFile: "--task-file",
  provider: "--provider",
  model: "--model",
  approvalPolicy: "--approval-policy",
  outputDir: "--output-dir",
  profile: "--profile",
  repoRoot: "--repo-root",
} as const satisfies Record<keyof RunArgs, `--${string}`>;

const fieldOf = new Map<string, keyof RunArgs>(
  Object.entries(flagOf).map(([field, flag]) => [flag, field as keyof RunArgs]),
);

const command = "run";

const oneOf = (options: object): string => {
  const names = Object.keys(options);
  return names.length === 1 ? `"${names[0]}"` : `one of ${names.join(", ")}`;
};

export const USAGE = `usage: coding-agent ${command} ${flagOf.taskFile} <path> ${flagOf.provider} <provider>
                    ${flagOf.model} <model-id> ${flagOf.approvalPolicy} auto-approve
                    ${flagOf.outputDir} <dir> [${flagOf.profile} <name>] [${flagOf.repoRoot} <dir>]

  ${flagOf.taskFile} <path>              required  file whose entire content is the Coding Task objective
  ${flagOf.provider} <provider>           required  ${Object.keys(providers).join(" | ")}
  ${flagOf.model} <model-id>              required  model identifier within that provider
  ${flagOf.approvalPolicy} auto-approve  required  only "auto-approve" is accepted
  ${flagOf.outputDir} <dir>              required  directory the run writes its files into
  ${flagOf.profile} <name>                optional  ${Object.keys(profiles).join(" | ")} (default: default)
  ${flagOf.repoRoot} <dir>               optional  defaults to the working directory`;

const problem = (flag: string | undefined, message: string): UsageProblem =>
  flag === undefined ? { message } : { flag, message };

const fail = (found: UsageProblem): ParseRunArgsResult => ({
  ok: false,
  code: "USAGE_ERROR",
  ...found,
});

function requireValue(flag: string, raw: string | undefined): string | UsageProblem {
  return raw === undefined ? problem(flag, `${flag} is required`) : raw;
}

function requireOneOf<T extends string>(
  flag: string,
  raw: string | undefined,
  options: Record<T, true>,
): T | UsageProblem {
  if (raw === undefined) return problem(flag, `${flag} is required`);
  return Object.hasOwn(options, raw)
    ? (raw as T)
    : problem(flag, `${flag} must be ${oneOf(options)}, not "${raw}"`);
}

/**
 * Reads the argument vector after the program name, including the `run` token itself, and the
 * working directory that `--repo-root` defaults to. Reports the first problem it finds, the way
 * `findConfigProblem` does in Agent Core.
 */
export function parseRunArgs(argv: readonly string[], cwd: string): ParseRunArgsResult {
  const [given, ...tokens] = argv;
  if (given === undefined) return fail(problem(undefined, "a command is required"));
  if (given !== command) return fail(problem(undefined, `unknown command "${given}"`));

  const raw: Partial<Record<keyof RunArgs, string>> = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) break;

    const separator = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = separator === -1 ? token : token.slice(0, separator);
    const field = fieldOf.get(flag);
    if (field === undefined) {
      return fail(
        token.startsWith("-")
          ? problem(flag, `unknown flag "${flag}"`)
          : problem(undefined, `unexpected argument "${token}"`),
      );
    }
    if (raw[field] !== undefined) return fail(problem(flag, `${flag} was given more than once`));

    let value = separator === -1 ? undefined : token.slice(separator + 1);
    const next = tokens[index + 1];
    // A `-` prefix is a flag, never this flag's value, the same rule that classifies unknown
    // tokens above. `--task-file=-odd` passes a value that genuinely starts with a dash.
    if (separator === -1 && next !== undefined && !next.startsWith("-")) {
      value = next;
      index++;
    }
    if (value === undefined || value.trim() === "") {
      return fail(problem(flag, `${flag} requires a value`));
    }
    raw[field] = value;
  }

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

  // This literal is the completeness proof: a missing RunArgs field is a type error.
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
