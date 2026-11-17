// Builds the evaluation artifact of ADR 0005 §2: both Linux executables and artifact-manifest.json.
// See scripts/README.md, "Evaluation artifact build", for the procedure.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROVIDER_CREDENTIAL_ENV_VARS, readEnvCredential } from "@coding-agent/ai";
// ADR 0004 §6 keeps the public surface of @coding-agent/coding-agent to its entry points, so the
// build reads these two modules from its source. Both are production code that the CLI runs.
import { checkAncestorCredentials } from "../packages/coding-agent/src/ancestor-credentials.ts";
import { formatVersion } from "../packages/coding-agent/src/build-info.ts";

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
const packageRoot = join(repoRoot, "packages", "coding-agent");
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

// The target for this host's platform and architecture, if any.
export const hostTarget = (platform: string, arch: string): Target | undefined =>
  TARGETS.find((target) => target.platform === platform && target.arch === arch);

// The provider credential variable that this process holds, if any. process.env also holds what
// Bun loaded from the repository's `.env`, which /proc/self/environ does not show.
export const heldProviderCredential = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => readEnvCredential(PROVIDER_CREDENTIAL_ENV_VARS, env)?.variable;

// An out-dir in the repository that git does not ignore would make the next build find these files
// and refuse the dirty tree. The trailing separator makes git match a directory pattern, such as
// `dist/`, against a directory that does not exist yet.
export async function outDirProblem(outDir: string, root = repoRoot): Promise<string | undefined> {
  const inRepo = relative(root, outDir);
  if (inRepo === ".." || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo)) return undefined;
  const ignored =
    inRepo !== "" &&
    (await spawnAndCollect(["git", "check-ignore", "-q", `${outDir}${sep}`], root)).exitCode === 0;
  return ignored
    ? undefined
    : `${outDir} is in the repository but git does not ignore it, so the next build would refuse the dirty tree; choose an ignored or outside directory`;
}

// An executable that read the .env would open an Agent Session and contact the provider, so a probe
// that runs longer than this is killed.
const PROBE_TIMEOUT_MS = 30_000;

// Git and `bun build` keep the whole environment: Bun needs its cache and temporary directories to
// download a cross-compilation target. A probe of a built executable gets only PATH, so a
// credential of the caller cannot decide its outcome, and is killed after the timeout.
async function spawnAndCollect(
  command: readonly string[],
  cwd: string,
  options: { readonly probe?: boolean } = {},
) {
  const child = Bun.spawn([...command], {
    cwd,
    env: options.probe === true ? { PATH: process.env.PATH ?? "" } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer =
    options.probe === true
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, PROBE_TIMEOUT_MS)
      : undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function git(args: readonly string[]): Promise<string> {
  const result = await spawnAndCollect(["git", ...args], repoRoot);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

// A probe runs in a temporary directory next to a `bunfig.toml` whose preload writes "preloaded" to
// standard error, so an executable that reads it shows.
async function withProbeDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-artifact-"));
  try {
    await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await Bun.write(join(directory, "preload.ts"), 'process.stderr.write("preloaded\\n");\n');
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const describeProbeResult = (result: Awaited<ReturnType<typeof spawnAndCollect>>): string =>
  `${result.timedOut ? `killed after ${PROBE_TIMEOUT_MS / 1000} s, ` : ""}exit ${result.exitCode}, stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)}`;

// `--version` must print exactly the line of the manifest, and standard error must stay empty.
async function checkVersion(executable: string, expected: string): Promise<void> {
  await withProbeDirectory(async (directory) => {
    const result = await spawnAndCollect([executable, "--version"], directory, { probe: true });
    const line = `${expected}\n`;
    if (result.exitCode !== 0 || result.stdout !== line || result.stderr !== "") {
      throw new Error(
        `${executable} --version does not match the manifest: ${describeProbeResult(result)}, expected stdout ${JSON.stringify(line)}`,
      );
    }
  });
}

// A `.env` that sets the provider credential must not supply it, and the `bunfig.toml` preload must
// not run. Exit 2 means that no Agent Session opened (ADR 0005 §3), and the error must name the
// variable, so the run stopped because the credential was missing.
async function checkRunIgnoresDotenvAndBunfig(executable: string): Promise<void> {
  await withProbeDirectory(async (directory) => {
    await Bun.write(join(directory, ".env"), "ANTHROPIC_API_KEY=not-a-real-credential\n");
    await Bun.write(join(directory, "task.md"), "Print the working directory.\n");
    const result = await spawnAndCollect(
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
      { probe: true },
    );
    const first = result.stderr.split("\n")[0] ?? "";
    if (
      result.exitCode !== 2 ||
      !first.includes("ANTHROPIC_API_KEY") ||
      result.stderr.includes("preloaded")
    ) {
      throw new Error(
        `${executable} run did not stop on the missing credential without the preload, so it read the .env or the bunfig.toml in its working directory: ${describeProbeResult(result)}`,
      );
    }
  });
}

// The probe of `run` uses "auto-approve", so on Linux the executable refuses the run if this
// process or one that started it holds a provider credential (ADR 0001 §8). The build refuses
// first, so the probe cannot fail for that reason.
async function credentialProblem(): Promise<string | undefined> {
  const held = heldProviderCredential(process.env);
  if (held !== undefined) {
    return `${held} is set in the environment of this build, or in the repository's .env; unset it and run the build again`;
  }
  const ancestors = await checkAncestorCredentials("auto-approve");
  return ancestors.ok
    ? undefined
    : `the .env check cannot run: ${ancestors.message}; unset the credential and run the build again`;
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
  // The executable is built from the bin entry, the same file that the package runs.
  const pkg = (await Bun.file(join(packageRoot, "package.json")).json()) as {
    version: string;
    bin?: Record<string, string>;
  };
  const bin = pkg.bin?.["coding-agent"];
  if (bin === undefined) {
    process.stderr.write("build-artifact: packages/coding-agent/package.json has no bin entry\n");
    return 1;
  }
  const entry = resolve(packageRoot, bin);

  const host = hostTarget(process.platform, process.arch);
  const runnableOnHost = host !== undefined && existsSync(host.loader) ? host : undefined;
  if (runnableOnHost !== undefined) {
    const held = await credentialProblem();
    if (held !== undefined) {
      process.stderr.write(`build-artifact: ${held}\n`);
      return 1;
    }
  }

  await mkdir(outDir, { recursive: true });
  // A manifest left by an earlier build must not describe these executables.
  await rm(join(outDir, MANIFEST_FILE), { force: true });

  const builds = await Promise.all(
    TARGETS.map(async ({ file, target }) => {
      const outfile = join(outDir, file);
      process.stderr.write(`build-artifact: building ${file} for ${target}\n`);
      const build = await spawnAndCollect(
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

  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    codingAgent: { version: pkg.version, commit },
    dirty,
    bunVersion: Bun.version,
    executables,
  };
  // The check reads the manifest back from the text that is written, so it compares with the file.
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const expected = formatVersion((JSON.parse(manifestText) as ArtifactManifest).codingAgent);
  if (host === undefined) {
    process.stderr.write(
      `build-artifact: this host (${process.platform} ${process.arch}) runs neither executable, so --version was not checked\n`,
    );
  } else if (runnableOnHost === undefined) {
    process.stderr.write(
      `build-artifact: this host has no glibc loader at ${host.loader}, so it cannot run ${host.file} and --version was not checked\n`,
    );
  } else {
    const executable = join(outDir, runnableOnHost.file);
    await checkVersion(executable, expected);
    await checkRunIgnoresDotenvAndBunfig(executable);
    process.stderr.write(
      `build-artifact: ${runnableOnHost.file} printed "${expected}" and ignored .env and bunfig.toml\n`,
    );
  }

  await Bun.write(join(outDir, MANIFEST_FILE), manifestText);
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
