import { constants, type Stats } from "node:fs";
import { access, chmod, mkdir, open, realpath, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunLimits } from "@coding-agent/agent-core";
import {
  createProviderDirectory,
  type Model,
  PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER,
  readEnvCredential,
} from "@coding-agent/ai";
import { errnoOf, normalizeWindowsShellPath } from "@coding-agent/tools";
import { readAtMost } from "./files.ts";
import type { AgentRunFlags, ProviderId } from "./flags.ts";
import type { Profile, RunArgs } from "./run-args.ts";

// The ADR 0003 §4 defaults. CDA-59 chose cancellationGraceMs: long enough for a tool or
// Verification child to go from SIGTERM to SIGKILL, and short enough that a cancelled run still
// writes its files inside the 10 s `docker stop` allows before it kills the container.
const DEFAULT_RUN_LIMITS: RunLimits = Object.freeze({
  maxModelTurns: 30,
  maxToolCalls: 100,
  maxDurationMs: 600_000,
  maxConsecutiveRecoverableFailures: 3,
  cancellationGraceMs: 5_000,
});

// The Evaluation Profiles of ADR 0005 §5. A profile selects only RunLimits: every other part of
// the configuration is the same under each, so the evaluated agent is the MVP with a larger budget.
// The values live here, not in a flag or an environment variable, so a build fixes them.
export const RUN_LIMITS_BY_PROFILE: Readonly<Record<Profile, RunLimits>> = Object.freeze({
  default: DEFAULT_RUN_LIMITS,
  terminalbench: Object.freeze({
    maxModelTurns: 250,
    maxToolCalls: 1_000,
    maxDurationMs: 3_600_000,
    maxConsecutiveRecoverableFailures: 10,
    cancellationGraceMs: DEFAULT_RUN_LIMITS.cancellationGraceMs,
  }),
});

// null leaves a setting to the provider's own default.
export interface SamplingSettings {
  readonly maxOutputTokens: number | null;
  readonly temperature: number | null;
}

// Anthropic requires a cap, and ai otherwise sends 4,096 tokens, too few for a large write.
export const SAMPLING_BY_PROVIDER: Readonly<Record<ProviderId, SamplingSettings>> = Object.freeze({
  anthropic: Object.freeze({ maxOutputTokens: 32_000, temperature: null }),
  google: Object.freeze({ maxOutputTokens: null, temperature: null }),
  openai: Object.freeze({ maxOutputTokens: null, temperature: null }),
  openrouter: Object.freeze({ maxOutputTokens: null, temperature: null }),
  xai: Object.freeze({ maxOutputTokens: null, temperature: null }),
  opencode: Object.freeze({ maxOutputTokens: null, temperature: null }),
});

export const TRANSPORT_RETRY_BOUND = 2;

// The only way to configure a verification command, for every entry point. It is not a flag,
// because ADR 0005 §3 fixes the command line, and not a repository file, because the repository
// the agent works on must not choose a command that runs without an Approval. The headless
// evaluation path leaves it unset (ADR 0005 §5).
export const VERIFICATION_COMMAND_ENV_VAR = "CODING_AGENT_VERIFICATION_COMMAND";

// An objective is a prompt, not a data file. A larger task file is almost certainly the wrong path,
// so no more than one byte past this limit is ever read, whatever size the file system reports.
export const MAX_TASK_FILE_BYTES = 1024 * 1024;

const TASK_OPEN_FLAGS = constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0);

const tooLarge = `is larger than ${MAX_TASK_FILE_BYTES / (1024 * 1024)} MiB`;

// The value lives in a closure, so serializing or inspecting a configuration never shows it.
export interface ResolvedCredential {
  readonly variable: string;
  reveal(): string;
}

export interface VerificationConfig {
  readonly command: string | null;
}

// What every entry point resolves before it opens an Agent Run: the model, its credential and
// the repository. `coding-agent run` adds a task and an output directory to it; the interactive
// path adds neither, because the person types the Coding Task and nothing is written to files.
export interface AgentRunSettings {
  readonly model: Model;
  readonly credential: ResolvedCredential;
  readonly sampling: SamplingSettings;
  readonly transportRetryBound: number;
  // The canonical Repository Root.
  readonly repoRoot: string;
  // The root as the command line spelled it, resolved against the working directory. It may pass
  // through a symbolic link, and the Workspace Resolver needs it to move an absolute path spelled
  // through it onto `repoRoot`.
  readonly givenRepoRoot: string;
  readonly verification: VerificationConfig;
}

export interface RunConfig extends AgentRunSettings {
  readonly objective: string;
  readonly taskFile: string;
  readonly approvalPolicy: RunArgs["approvalPolicy"];
  readonly outputDir: string;
  readonly profile: Profile;
  readonly limits: RunLimits;
}

export type ResolveRunConfigResult =
  | {
      readonly ok: true;
      readonly config: RunConfig;
      // The output directories this run created, for removeCreated when no Agent Run opens.
      readonly createdDirectories: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly message: string;
      readonly field: string;
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

// Resolve a command-line path, accepting the Git Bash, MSYS, Cygwin, and WSL drive spelling on
// Windows.
function resolveInput(cwd: string, given: string): string {
  return resolve(cwd, normalizeWindowsShellPath(given));
}

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
  const path = resolveInput(cwd, given);
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
  const path = resolveInput(cwd, given);
  let bytes: Uint8Array;
  try {
    // Opening a pipe would block and opening a device can have side effects, so the path is
    // checked before it is opened. The open does not block, and the handle is checked again in
    // case the path was replaced in between.
    const unfit = unfitTaskFile(await stat(path));
    if (unfit) return refuse(flag, `${flag} "${given}" ${unfit}`);
    const handle = await open(path, TASK_OPEN_FLAGS);
    try {
      const reopened = unfitTaskFile(await handle.stat());
      if (reopened) return refuse(flag, `${flag} "${given}" ${reopened}`);
      bytes = await readAtMost(handle, MAX_TASK_FILE_BYTES + 1);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return refuse(flag, `${flag} "${given}" ${unusable(error, "read")}`);
  }
  // The size checks above trust the file system. A file that grew after them, or one under /proc
  // or a FUSE mount that reports the wrong size, is caught here, after one byte too many.
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

// The directories that creating `path` would add, shallowest first: empty when `path` exists, or
// when a component above it is not a directory.
async function missingDirectories(path: string): Promise<string[]> {
  const missing: string[] = [];
  for (let dir = path; missing[0] !== dir; dir = dirname(dir)) {
    try {
      await stat(dir);
      break;
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") break;
      missing.unshift(dir);
    }
  }
  return missing;
}

// Windows reports a directory creation below a regular file as ENOENT rather than ENOTDIR, so the
// error alone cannot tell that case from a dangling symbolic link. Exported with an injectable
// stat so the unit test can reproduce that Windows error on any host.
type DirectoryStat = (path: string) => Promise<{ isDirectory(): boolean }>;

export async function parentIsFile(path: string, statPath: DirectoryStat = stat): Promise<boolean> {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return !(await statPath(dir)).isDirectory();
    } catch (error) {
      if (errnoOf(error) !== "ENOENT" || dirname(dir) === dir) return false;
    }
  }
}

// Removes the directories this run created, deepest first, so a run that is refused after creating
// them leaves nothing behind. They are this run's own, so each first gets owner rwx back in case
// the umask created it read-only. rmdir never removes a directory something else has filled, and a
// failure leaves the rest in place: the refusal is what the caller reports.
export async function removeCreated(created: readonly string[]): Promise<void> {
  for (const dir of created) {
    await stat(dir)
      .then(({ mode }) => chmod(dir, (mode & 0o7777) | 0o700))
      .catch(() => undefined);
  }
  for (const dir of [...created].reverse()) await rmdir(dir).catch(() => undefined);
}

interface OutputDir {
  readonly path: string;
  // The directories this run created, shallowest first; empty when the directory already existed.
  readonly created: readonly string[];
}

async function prepareOutputDir(cwd: string, given: string): Promise<Checked<OutputDir>> {
  const flag = "--output-dir";
  const path = resolveInput(cwd, given);
  // One level at a time, and never recursive: a directory is this run's only when its own mkdir
  // succeeded. EEXIST means something else made it first, so it is never removed.
  const created: string[] = [];
  const refuseAndRemove = async (reason: string): Promise<Refusal> => {
    await removeCreated(created);
    return refuse(flag, `${flag} "${given}" ${reason}`);
  };
  let found: Stats;
  try {
    for (const dir of await missingDirectories(path)) {
      try {
        await mkdir(dir);
        created.push(dir);
      } catch (error) {
        if (errnoOf(error) !== "EEXIST") throw error;
      }
    }
    found = await stat(path);
  } catch (error) {
    switch (errnoOf(error)) {
      case "ENOTDIR":
        return refuseAndRemove("cannot be created: a parent is not a directory");
      // A dangling symbolic link: mkdir finds the name taken, and stat finds nothing behind it.
      case "ENOENT":
        return refuseAndRemove(
          (await parentIsFile(path))
            ? "cannot be created: a parent is not a directory"
            : "is not a directory",
        );
      default:
        return refuseAndRemove(unusable(error, "created"));
    }
  }
  if (!found.isDirectory()) return refuseAndRemove("is not a directory");
  try {
    await access(path, constants.W_OK | constants.X_OK);
  } catch {
    return refuseAndRemove("is not writable");
  }
  return pass({ path, created });
}

// The checks that need no file written, cheapest first, and the first problem wins. Both entry
// points call it, so a refusal reads the same on either, and it creates nothing to remove.
export async function resolveAgentRunSettings(
  flags: AgentRunFlags,
  { cwd, env }: ResolveRunConfigContext,
): Promise<Checked<AgentRunSettings>> {
  const model = createProviderDirectory().getModel(flags.provider, flags.model);
  if (model === undefined) {
    return refuse("--model", `--model "${flags.model}" is not a known ${flags.provider} model`);
  }

  const variables = PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER[flags.provider];
  const credential = readEnvCredential(variables, env);
  if (credential === undefined) {
    return refuse(
      variables[0],
      `no credential for --provider ${flags.provider}: set ${variables.join(" or ")}`,
    );
  }

  const command = env[VERIFICATION_COMMAND_ENV_VAR];
  if (command !== undefined && command.trim() === "") {
    return refuse(
      VERIFICATION_COMMAND_ENV_VAR,
      `${VERIFICATION_COMMAND_ENV_VAR} is set but blank; unset it to configure no command`,
    );
  }

  const repoRoot = await resolveRepoRoot(cwd, flags.repoRoot);
  if (!repoRoot.ok) return repoRoot;

  const { variable, value } = credential;
  return pass({
    model,
    credential: { variable, reveal: () => value },
    sampling: SAMPLING_BY_PROVIDER[flags.provider],
    transportRetryBound: TRANSPORT_RETRY_BOUND,
    repoRoot: repoRoot.value.canonical,
    givenRepoRoot: repoRoot.value.given,
    verification: { command: command ?? null },
  });
}

// The Agent Run settings first, then the task, and the output directory last because it is the only
// check that writes: it is created only once every other check has passed, and removed again if it
// is refused.
export async function resolveRunConfig(
  args: RunArgs,
  context: ResolveRunConfigContext,
): Promise<ResolveRunConfigResult> {
  const settings = await resolveAgentRunSettings(args, context);
  if (!settings.ok) return settings;
  const task = await readObjective(context.cwd, args.taskFile);
  if (!task.ok) return task;
  const outputDir = await prepareOutputDir(context.cwd, args.outputDir);
  if (!outputDir.ok) return outputDir;

  return {
    ok: true,
    createdDirectories: outputDir.value.created,
    config: {
      ...settings.value,
      objective: task.value.objective,
      taskFile: task.value.path,
      approvalPolicy: args.approvalPolicy,
      outputDir: outputDir.value.path,
      profile: args.profile,
      limits: RUN_LIMITS_BY_PROFILE[args.profile],
    },
  };
}
