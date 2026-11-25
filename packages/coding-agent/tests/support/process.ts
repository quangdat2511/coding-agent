// Helpers for tests that run the Coding Agent, or a probe, as a child process.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun with the flags of the executable's shebang, so no bunfig.toml or .env of the host takes part,
// for a test that must add a flag such as --preload. Bun 1.3.14 on Windows accepts no empty device
// as --config, so there it reads an empty file instead.
export const bunLikeShebang: readonly string[] = [
  process.execPath,
  "--no-env-file",
  `--config=${process.platform === "win32" ? join(import.meta.dir, "empty-bunfig.toml") : "/dev/null"}`,
];

export const firstLine = (text: string): string => text.split("\n")[0] ?? "";

// A bunfig.toml whose preload writes "preloaded" to standard error, so a launch that reads it shows.
export async function writePreloadingBunfig(directory: string): Promise<void> {
  await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await Bun.write(join(directory, "preload.ts"), 'process.stderr.write("preloaded\\n");\n');
}

// Windows can keep an executable locked for a moment after it exits, so removal retries.
const REMOVE_ATTEMPTS = 10;
const REMOVE_RETRY_MS = 100;
const RETRYABLE_REMOVE: ReadonlySet<string | undefined> = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeDirectory(directory: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= REMOVE_ATTEMPTS || !RETRYABLE_REMOVE.has(code)) throw error;
      await Bun.sleep(REMOVE_RETRY_MS * attempt);
    }
  }
}

export async function withTemporaryDirectory<T>(
  body: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-test-"));
  try {
    return await body(directory);
  } finally {
    await removeDirectory(directory);
  }
}

// Children get only PATH (to find bun) plus what a test adds, so a developer's own provider keys
// never decide whether a credential is present.
export function startProcess(
  command: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const finished = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({
    exitCode,
    stdout,
    stderr,
    // Bun gives a child that a signal killed the exit code 128 + n, as if it had exited itself.
    killedBy: child.signalCode,
  }));
  return { finished, signal: (name: "SIGINT" | "SIGTERM" | "SIGKILL") => child.kill(name) };
}

export const runProcess = (...args: Parameters<typeof startProcess>) =>
  startProcess(...args).finished;
