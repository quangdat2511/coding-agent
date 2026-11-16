// Builds the evaluation artifact of ADR 0005 §2: both Linux executables and artifact-manifest.json.
// See scripts/README.md, "Evaluation artifact build", for the procedure.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatVersion } from "../packages/coding-agent/src/build-info.ts";
import { runnerChainIsClean } from "../packages/coding-agent/tests/support/ancestor-chain.ts";
import {
  startProcess,
  withTemporaryDirectory,
  writePreloadingBunfig,
} from "../packages/coding-agent/tests/support/process.ts";

export const MANIFEST_FILE = "artifact-manifest.json";

// `loader` is the glibc dynamic loader that each executable names. A musl host has none, so it
// cannot run the executable.
export const TARGETS = [
  {
    file: "coding-agent-linux-x64",
    target: "bun-linux-x64-baseline",
    platform: "linux",
    arch: "x64",
    loader: "/lib64/ld-linux-x86-64.so.2",
  },
  {
    file: "coding-agent-linux-arm64",
    target: "bun-linux-arm64",
    platform: "linux",
    arch: "arm64",
    loader: "/lib/ld-linux-aarch64.so.1",
  },
] as const;

export type Target = (typeof TARGETS)[number];

// Autoloading stays off, so a `.env` or `bunfig.toml` in a task's working directory cannot
// configure the agent.
const AUTOLOAD_FLAGS = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"] as const;

const repoRoot = resolve(import.meta.dir, "..");
const entry = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const defaultOutDir = join(repoRoot, "dist", "artifact");

export interface BuildArgs {
  readonly outDir: string;
  readonly allowDirty: boolean;
}

export const USAGE = "usage: bun run build:artifact [--out-dir <dir>] [--allow-dirty]";

export function parseBuildArgs(
  argv: readonly string[],
  cwd: string,
): { ok: true; args: BuildArgs } | { ok: false; message: string } {
  let outDir: string | undefined;
  let allowDirty = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--allow-dirty") {
      allowDirty = true;
    } else if (token === "--out-dir") {
      const value = argv[++index];
      if (value === undefined || value.trim() === "" || value.startsWith("-")) {
        return { ok: false, message: "--out-dir requires a value" };
      }
      outDir = resolve(cwd, value);
    } else {
      return { ok: false, message: `unexpected argument "${token}"` };
    }
  }
  return { ok: true, args: { outDir: outDir ?? defaultOutDir, allowDirty } };
}

export interface SourceState {
  readonly head: string;
  // `git status --porcelain` output: empty when the working tree is clean.
  readonly status: string;
}

// A dirty build is refused unless asked for. Then its commit carries a `-dirty` suffix, which
// `--version` prints too, so the artifact cannot pass for a build of the commit alone.
export function resolveCommit(
  source: SourceState,
  allowDirty: boolean,
): { ok: true; commit: string; dirty: boolean } | { ok: false; message: string } {
  const dirty = source.status.trim() !== "";
  if (!dirty) return { ok: true, commit: source.head, dirty };
  if (!allowDirty) {
    return {
      ok: false,
      message: `the working tree is dirty, so the build cannot name one commit:\n${source.status.trimEnd()}\ncommit or remove these changes, or pass --allow-dirty to build an artifact marked dirty`,
    };
  }
  return { ok: true, commit: `${source.head}-dirty`, dirty };
}

export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly codingAgent: { readonly version: string; readonly commit: string };
  readonly dirty: boolean;
  readonly bunVersion: string;
  readonly executables: readonly {
    readonly file: string;
    readonly target: string;
    readonly sha256: string;
  }[];
}

// The executable that this host can run, if any, so the build can check its `--version`.
export const runnableTarget = (platform: string, arch: string): Target | undefined =>
  TARGETS.find((target) => target.platform === platform && target.arch === arch);

// Git and `bun build` keep the whole environment: Bun needs its cache and temporary directories to
// download a cross-compilation target.
async function run(command: readonly string[], cwd: string) {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(args: readonly string[]): Promise<string> {
  const result = await run(["git", ...args], repoRoot);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

// An executable that read the .env would open an Agent Session and contact the provider, so a probe
// that runs longer than this is killed.
const PROBE_TIMEOUT_MS = 30_000;

// A probe of a built executable gets only PATH (startProcess), so a credential of the caller cannot
// decide its outcome.
async function probe(command: readonly string[], cwd: string) {
  const child = startProcess(command, { cwd });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.signal("SIGKILL");
  }, PROBE_TIMEOUT_MS);
  try {
    const result = await child.finished;
    return { ...result, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

const describe = (result: Awaited<ReturnType<typeof probe>>): string =>
  `${result.timedOut ? `killed after ${PROBE_TIMEOUT_MS / 1000} s, ` : ""}exit ${result.exitCode}, stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)}`;

// Runs `--version` next to a `bunfig.toml` whose preload would write to standard error, and
// requires exactly the line the manifest implies.
async function checkVersion(executable: string, expected: string): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    await writePreloadingBunfig(directory);
    const result = await probe([executable, "--version"], directory);
    const line = `${expected}\n`;
    if (result.exitCode !== 0 || result.stdout !== line || result.stderr !== "") {
      throw new Error(
        `${executable} --version does not match the manifest: ${describe(result)}, expected stdout ${JSON.stringify(line)}`,
      );
    }
  });
}

// A `.env` that sets the provider credential must not supply it, so the run stops with the
// configuration error of a missing credential.
const MISSING_CREDENTIAL =
  "coding-agent: no credential for --provider anthropic: set ANTHROPIC_API_KEY";

async function checkDotenvIgnored(executable: string): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    await Bun.write(join(directory, ".env"), "ANTHROPIC_API_KEY=not-a-real-credential\n");
    await Bun.write(join(directory, "task.md"), "Print the working directory.\n");
    const result = await probe(
      [
        executable,
        "run",
        "--task-file",
        "task.md",
        "--provider",
        "anthropic",
        "--model",
        "claude-haiku-4-5",
        "--approval-policy",
        "auto-approve",
        "--output-dir",
        "out",
      ],
      directory,
    );
    if (result.exitCode !== 2 || result.stderr.split("\n")[0] !== MISSING_CREDENTIAL) {
      throw new Error(
        `${executable} run did not stop with the missing-credential error, so it may have read the .env in its working directory: ${describe(result)}`,
      );
    }
  });
}

// An out-dir in the repository that git does not ignore would make the next build find these files
// and refuse the dirty tree.
async function outDirProblem(outDir: string): Promise<string | undefined> {
  const inRepo = relative(repoRoot, outDir);
  if (inRepo === ".." || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo)) return undefined;
  const ignored =
    inRepo !== "" && (await run(["git", "check-ignore", "-q", outDir], repoRoot)).exitCode === 0;
  return ignored
    ? undefined
    : `${outDir} is in the repository but git does not ignore it, so the next build would refuse the dirty tree; choose an ignored or outside directory`;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseBuildArgs(argv, process.cwd());
  if (!parsed.ok) {
    process.stderr.write(`build-artifact: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { outDir, allowDirty } = parsed.args;

  const pinnedBun = (await Bun.file(join(repoRoot, ".bun-version")).text()).trim();
  if (Bun.version !== pinnedBun) {
    process.stderr.write(
      `build-artifact: Bun ${Bun.version} is running, but .bun-version pins ${pinnedBun}\n`,
    );
    return 1;
  }

  // An empty directory does not make the tree dirty, and git can tell whether it ignores it only
  // once it exists.
  await mkdir(outDir, { recursive: true });
  const problem = await outDirProblem(outDir);
  if (problem !== undefined) {
    process.stderr.write(`build-artifact: ${problem}\n`);
    return 1;
  }

  const source = {
    head: (await git(["rev-parse", "HEAD"])).trim(),
    status: await git(["status", "--porcelain", "--untracked-files=all"]),
  };
  const resolved = resolveCommit(source, allowDirty);
  if (!resolved.ok) {
    process.stderr.write(`build-artifact: ${resolved.message}\n`);
    return 1;
  }
  const { commit, dirty } = resolved;
  const version = (
    (await Bun.file(join(repoRoot, "packages", "coding-agent", "package.json")).json()) as {
      version: string;
    }
  ).version;

  const runnable = runnableTarget(process.platform, process.arch);
  const checkable = runnable !== undefined && existsSync(runnable.loader) ? runnable : undefined;
  // The .env probe runs under "auto-approve", so on Linux its ancestor check reads this process
  // and the processes that started it. A provider key there, for example from the repository's
  // .env that `bun run` loads, would stop the probe before the credential check.
  if (checkable !== undefined && !(await runnerChainIsClean())) {
    process.stderr.write(
      "build-artifact: a provider credential is in the environment of this build or of a process that started it, so the .env check would stop at the ancestor check (ADR 0001 §8); unset it, or remove it from the repository's .env, and run the build again\n",
    );
    return 1;
  }

  // A manifest left by an earlier build must not describe these executables.
  await rm(join(outDir, MANIFEST_FILE), { force: true });

  const builds = await Promise.all(
    TARGETS.map(async ({ file, target }) => {
      const outfile = join(outDir, file);
      process.stderr.write(`build-artifact: building ${file} for ${target}\n`);
      const build = await run(
        [
          process.execPath,
          "build",
          entry,
          "--compile",
          `--target=${target}`,
          ...AUTOLOAD_FLAGS,
          "--define",
          `CODING_AGENT_COMMIT=${JSON.stringify(commit)}`,
          "--outfile",
          outfile,
        ],
        repoRoot,
      );
      return { file, target, outfile, build };
    }),
  );
  const executables: ArtifactManifest["executables"][number][] = [];
  for (const { file, target, outfile, build } of builds) {
    if (build.exitCode !== 0) {
      process.stderr.write(`build-artifact: bun build failed for ${target}:\n${build.stderr}`);
      return 1;
    }
    executables.push({ file, target, sha256: await sha256(outfile) });
  }

  const expected = formatVersion({ version, commit });
  if (runnable === undefined) {
    process.stderr.write(
      `build-artifact: this host (${process.platform} ${process.arch}) runs neither executable, so --version was not checked\n`,
    );
  } else if (checkable === undefined) {
    process.stderr.write(
      `build-artifact: this host has no glibc loader at ${runnable.loader}, so it cannot run ${runnable.file} and --version was not checked\n`,
    );
  } else {
    const executable = join(outDir, checkable.file);
    await checkVersion(executable, expected);
    await checkDotenvIgnored(executable);
    process.stderr.write(
      `build-artifact: ${checkable.file} printed "${expected}" and ignored .env and bunfig.toml\n`,
    );
  }

  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    codingAgent: { version, commit },
    dirty,
    bunVersion: Bun.version,
    executables,
  };
  await Bun.write(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`build-artifact: wrote ${join(outDir, MANIFEST_FILE)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build-artifact: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
