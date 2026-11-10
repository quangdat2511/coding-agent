// Helpers for tests that run the Coding Agent, or a probe, as a child process.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun with the flags of the executable's shebang, so no bunfig.toml or .env of the host takes part,
// for a test that must add a flag such as --preload. Bun 1.3.14 on Windows crashes on
// --config=/dev/null, so Windows runs without that flag.
export const bunLikeShebang: readonly string[] = [
  process.execPath,
  "--no-env-file",
  ...(process.platform === "win32" ? [] : ["--config=/dev/null"]),
];

export const firstLine = (text: string): string => text.split("\n")[0] ?? "";

export async function withTemporaryDirectory<T>(
  body: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-test-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Children get only PATH (to find bun) plus what a test adds, so a developer's own provider keys
// never decide whether a credential is present.
export async function runProcess(
  command: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "", ...options.env },
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
