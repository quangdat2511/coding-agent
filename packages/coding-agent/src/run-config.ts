import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionLimits } from "@coding-agent/agent-core";
import {
  createProviderDirectory,
  type Model,
  PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER,
} from "@coding-agent/ai";
import type { Profile, RunArgs } from "./run-args.ts";

// The ADR 0003 §4 defaults. CDA-59 chose cancellationGraceMs: long enough for a tool or
// Verification child to go from SIGTERM to SIGKILL, and short enough that a cancelled run still
// writes its files inside the 10 s `docker stop` allows before it kills the container.
export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxModelTurns: 30,
  maxToolCalls: 100,
  maxDurationMs: 600_000,
  maxConsecutiveRecoverableFailures: 3,
  cancellationGraceMs: 5_000,
});

// The only way to configure a verification command, for every entry point. It is not a flag,
// because ADR 0005 §3 fixes the command line, and not a repository file, because the repository
// the agent works on must not choose a command that runs without an Approval. The headless
// evaluation path leaves it unset (ADR 0005 §5).
export const VERIFICATION_COMMAND_ENV_VAR = "CODING_AGENT_VERIFICATION_COMMAND";

// The value lives in a closure, so serializing or inspecting a configuration never shows it.
export interface ResolvedCredential {
  readonly variable: string;
  reveal(): string;
}

export interface VerificationConfig {
  readonly command: string | null;
}

export interface RunConfig {
  readonly objective: string;
  readonly taskFile: string;
  readonly model: Model;
  readonly credential: ResolvedCredential;
  readonly approvalPolicy: RunArgs["approvalPolicy"];
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly profile: Profile;
  readonly limits: SessionLimits;
  readonly verification: VerificationConfig;
}

export type ResolveRunConfigResult =
  | { readonly ok: true; readonly config: RunConfig }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly message: string;
      readonly field: string;
    }
  // Temporary: CDA-79 (D3.3) resolves terminalbench to the ADR 0005 §5 limits and removes this.
  | {
      readonly ok: false;
      readonly code: "NOT_IMPLEMENTED";
      readonly message: string;
      readonly field: "--profile";
    };

export interface ResolveRunConfigContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

type Refusal = Extract<ResolveRunConfigResult, { code: "INVALID_CONFIGURATION" }>;

const refuse = (field: string, message: string): Refusal => ({
  ok: false,
  code: "INVALID_CONFIGURATION",
  field,
  message,
});

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

// Describes why a path given on the command line could not be used, as the end of a sentence that
// starts with the flag and the path.
function unusable(error: unknown, action: "read" | "created"): string {
  switch (errnoOf(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return "does not exist";
    case "EACCES":
    case "EPERM":
      return `cannot be ${action}: permission denied`;
    default:
      return `cannot be ${action}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function resolveRepoRoot(cwd: string, given: string): Promise<string | Refusal> {
  const flag = "--repo-root";
  try {
    const root = await realpath(resolve(cwd, given));
    if (!(await stat(root)).isDirectory()) {
      return refuse(flag, `${flag} "${given}" is not a directory`);
    }
    await access(root, constants.R_OK | constants.X_OK);
    return root;
  } catch (error) {
    return refuse(flag, `${flag} "${given}" ${unusable(error, "read")}`);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

async function readObjective(
  cwd: string,
  given: string,
): Promise<{ readonly path: string; readonly objective: string } | Refusal> {
  const flag = "--task-file";
  const path = resolve(cwd, given);
  let bytes: Uint8Array;
  try {
    // A pipe or device would block the read, so only a regular file is opened.
    const found = await stat(path);
    if (found.isDirectory()) return refuse(flag, `${flag} "${given}" is a directory`);
    if (!found.isFile()) return refuse(flag, `${flag} "${given}" is not a regular file`);
    bytes = await readFile(path);
  } catch (error) {
    return refuse(flag, `${flag} "${given}" ${unusable(error, "read")}`);
  }
  let objective: string;
  try {
    objective = utf8.decode(bytes);
  } catch {
    return refuse(flag, `${flag} "${given}" is not valid UTF-8`);
  }
  return objective.trim() === ""
    ? refuse(flag, `${flag} "${given}" is blank`)
    : { path, objective };
}

async function prepareOutputDir(cwd: string, given: string): Promise<string | Refusal> {
  const flag = "--output-dir";
  const path = resolve(cwd, given);
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    switch (errnoOf(error)) {
      case "EEXIST":
        return refuse(flag, `${flag} "${given}" is not a directory`);
      case "ENOTDIR":
        return refuse(flag, `${flag} "${given}" cannot be created: a parent is not a directory`);
      default:
        return refuse(flag, `${flag} "${given}" ${unusable(error, "created")}`);
    }
  }
  try {
    await access(path, constants.W_OK | constants.X_OK);
  } catch {
    return refuse(flag, `${flag} "${given}" is not writable`);
  }
  return path;
}

// Checks run from the cheapest to the only one that writes, and the first problem wins: the output
// directory is created only once every other check has passed.
export async function resolveRunConfig(
  args: RunArgs,
  { cwd, env }: ResolveRunConfigContext,
): Promise<ResolveRunConfigResult> {
  const model = createProviderDirectory().getModel(args.provider, args.model);
  if (model === undefined) {
    return refuse("--model", `--model "${args.model}" is not a known ${args.provider} model`);
  }

  const variables = PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER[args.provider];
  const variable = variables.find((name) => env[name]?.trim());
  const value = variable && env[variable];
  if (!variable || !value) {
    return refuse(
      variables[0],
      `no credential for --provider ${args.provider}: set ${variables.join(" or ")}`,
    );
  }

  const command = env[VERIFICATION_COMMAND_ENV_VAR];
  if (command !== undefined && command.trim() === "") {
    return refuse(
      VERIFICATION_COMMAND_ENV_VAR,
      `${VERIFICATION_COMMAND_ENV_VAR} is set but blank; unset it to configure no command`,
    );
  }

  const repoRoot = await resolveRepoRoot(cwd, args.repoRoot);
  if (typeof repoRoot !== "string") return repoRoot;
  const task = await readObjective(cwd, args.taskFile);
  if ("ok" in task) return task;
  const outputDir = await prepareOutputDir(cwd, args.outputDir);
  if (typeof outputDir !== "string") return outputDir;

  // Checked last so that a terminalbench run still reports every configuration error as one.
  if (args.profile === "terminalbench") {
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      field: "--profile",
      message: "--profile terminalbench is not implemented yet; CDA-79 (D3.3) adds its limits",
    };
  }

  return {
    ok: true,
    config: {
      objective: task.objective,
      taskFile: task.path,
      model,
      credential: { variable, reveal: () => value },
      approvalPolicy: args.approvalPolicy,
      repoRoot,
      outputDir,
      profile: args.profile,
      limits: DEFAULT_SESSION_LIMITS,
      verification: { command: command ?? null },
    },
  };
}
