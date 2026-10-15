import { constants, type Stats } from "node:fs";
import { access, chmod, mkdir, open, realpath, rmdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SessionLimits } from "@coding-agent/agent-core";
import {
  createProviderDirectory,
  type Model,
  PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER,
  readEnvCredential,
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

// An objective is a prompt, not a data file. A larger task file is almost certainly the wrong path,
// and reading it whole would exhaust memory long before a model could take it.
export const MAX_TASK_FILE_BYTES = 1024 * 1024;

const tooLarge = `is larger than ${MAX_TASK_FILE_BYTES / (1024 * 1024)} MiB`;

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
  // The canonical Repository Root.
  readonly repoRoot: string;
  // The root as the command line spelled it, resolved against the working directory. It may pass
  // through a symbolic link, and the Workspace Resolver needs it to move an absolute path spelled
  // through it onto `repoRoot`.
  readonly givenRepoRoot: string;
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

// What each check returns: the value it resolved, or the refusal that ends resolution.
type Checked<T> = { readonly ok: true; readonly value: T } | Refusal;

const pass = <T>(value: T): Checked<T> => ({ ok: true, value });

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

interface RepoRoot {
  readonly canonical: string;
  readonly given: string;
}

async function resolveRepoRoot(cwd: string, given: string): Promise<Checked<RepoRoot>> {
  const flag = "--repo-root";
  // run-args.ts fills an omitted --repo-root with the working directory, so say so rather than
  // name a flag that was never passed.
  const subject =
    given === cwd ? `the working directory "${cwd}" (the default ${flag})` : `${flag} "${given}"`;
  const path = resolve(cwd, given);
  let root: string;
  try {
    root = await realpath(path);
    if (!(await stat(root)).isDirectory()) return refuse(flag, `${subject} is not a directory`);
    await access(root, constants.R_OK | constants.X_OK);
  } catch (error) {
    return refuse(flag, `${subject} ${unusable(error, "read")}`);
  }
  // write and edit Tool Calls and the verification command change files below the root.
  try {
    await access(root, constants.W_OK);
  } catch {
    return refuse(flag, `${subject} is not writable`);
  }
  return pass({ canonical: root, given: path });
}

// Why a task file cannot be read as an objective, or undefined when it can.
function unfitTaskFile(found: Stats): string | undefined {
  if (found.isDirectory()) return "is a directory";
  if (!found.isFile()) return "is not a regular file";
  if (found.size > MAX_TASK_FILE_BYTES) return tooLarge;
  return undefined;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

interface Task {
  readonly path: string;
  readonly objective: string;
}

async function readObjective(cwd: string, given: string): Promise<Checked<Task>> {
  const flag = "--task-file";
  const path = resolve(cwd, given);
  let bytes: Uint8Array;
  try {
    // Opening a pipe would block and opening a device can have side effects, so the path is
    // checked before it is opened. The open does not block, and the handle is checked again in
    // case the path was replaced in between.
    const unfit = unfitTaskFile(await stat(path));
    if (unfit) return refuse(flag, `${flag} "${given}" ${unfit}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const reopened = unfitTaskFile(await handle.stat());
      if (reopened) return refuse(flag, `${flag} "${given}" ${reopened}`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    return refuse(flag, `${flag} "${given}" ${unusable(error, "read")}`);
  }
  // The file may have grown after it was checked.
  if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
    return refuse(flag, `${flag} "${given}" ${tooLarge}`);
  }
  let objective: string;
  try {
    objective = utf8.decode(bytes);
  } catch {
    return refuse(flag, `${flag} "${given}" is not valid UTF-8`);
  }
  return objective.trim() === ""
    ? refuse(flag, `${flag} "${given}" is blank`)
    : pass({ path, objective });
}

// The shallowest directory that creating `path` would add, or undefined when `path` exists or
// cannot be created at all.
async function firstMissingDirectory(path: string): Promise<string | undefined> {
  let missing: string | undefined;
  for (let dir = path; missing !== dir; dir = dirname(dir)) {
    try {
      await stat(dir);
      break;
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") break;
      missing = dir;
    }
  }
  return missing;
}

// Removes the directories from `created` down to `path`, deepest first, so a run that is refused
// after creating them leaves nothing behind. They belong to this process, so each is first made
// writable in case the umask created it read-only. rmdir never removes a directory something else
// has filled, and a failure leaves the rest in place: the refusal is what the caller reports.
async function removeCreated(created: string, path: string): Promise<void> {
  const chain = [created];
  let dir = created;
  for (const segment of relative(created, path).split(sep)) {
    if (segment === "") continue;
    dir = join(dir, segment);
    chain.push(dir);
  }
  for (const each of chain) await chmod(each, 0o700).catch(() => undefined);
  for (const each of chain.reverse()) await rmdir(each).catch(() => undefined);
}

interface OutputDir {
  readonly path: string;
  // The shallowest directory this run created, or undefined when the directory already existed.
  readonly created: string | undefined;
}

async function prepareOutputDir(cwd: string, given: string): Promise<Checked<OutputDir>> {
  const flag = "--output-dir";
  const path = resolve(cwd, given);
  const created = await firstMissingDirectory(path);
  const refuseAndRemove = async (reason: string): Promise<Refusal> => {
    if (created !== undefined) await removeCreated(created, path);
    return refuse(flag, `${flag} "${given}" ${reason}`);
  };
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    switch (errnoOf(error)) {
      case "EEXIST":
        return refuseAndRemove("is not a directory");
      case "ENOTDIR":
        return refuseAndRemove("cannot be created: a parent is not a directory");
      default:
        return refuseAndRemove(unusable(error, "created"));
    }
  }
  try {
    await access(path, constants.W_OK | constants.X_OK);
  } catch {
    return refuseAndRemove("is not writable");
  }
  return pass({ path, created });
}

// Checks run from the cheapest to the only one that writes, and the first problem wins: the output
// directory is created only once every other check has passed, and removed again if it is refused.
export async function resolveRunConfig(
  args: RunArgs,
  { cwd, env }: ResolveRunConfigContext,
): Promise<ResolveRunConfigResult> {
  const model = createProviderDirectory().getModel(args.provider, args.model);
  if (model === undefined) {
    return refuse("--model", `--model "${args.model}" is not a known ${args.provider} model`);
  }

  const variables = PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER[args.provider];
  const credential = readEnvCredential(variables, env);
  if (credential === undefined) {
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
  if (!repoRoot.ok) return repoRoot;
  const task = await readObjective(cwd, args.taskFile);
  if (!task.ok) return task;
  const outputDir = await prepareOutputDir(cwd, args.outputDir);
  if (!outputDir.ok) return outputDir;

  // Checked last so that a terminalbench run still reports every configuration error as one. No
  // session runs, so the output directory it created is removed again.
  if (args.profile === "terminalbench") {
    const { path, created } = outputDir.value;
    if (created !== undefined) await removeCreated(created, path);
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      field: "--profile",
      message: "--profile terminalbench is not implemented yet; CDA-79 (D3.3) adds its limits",
    };
  }

  const { variable, value } = credential;
  return {
    ok: true,
    config: {
      objective: task.value.objective,
      taskFile: task.value.path,
      model,
      credential: { variable, reveal: () => value },
      approvalPolicy: args.approvalPolicy,
      repoRoot: repoRoot.value.canonical,
      givenRepoRoot: repoRoot.value.given,
      outputDir: outputDir.value.path,
      profile: args.profile,
      limits: DEFAULT_SESSION_LIMITS,
      verification: { command: command ?? null },
    },
  };
}
