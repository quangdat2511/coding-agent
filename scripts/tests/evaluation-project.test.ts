// The Harbor adapter at evaluation/terminalbench is a Python project with its own CI job
// (ADR 0005 §6). These tests keep the Bun workspaces, the TypeScript checks and Biome away from it.
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const repoRoot = resolve(import.meta.dir, "..", "..");
const PROJECT = "evaluation/terminalbench";
const PROJECT_FILES = [
  `${PROJECT}`,
  `${PROJECT}/pyproject.toml`,
  `${PROJECT}/src/coding_agent_terminalbench/agent.py`,
  `${PROJECT}/example.ts`,
  `${PROJECT}/.venv/lib/example.ts`,
];

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  (await Bun.file(join(repoRoot, path)).json()) as Record<string, unknown>;

const patterns = (value: unknown): string[] => {
  expect(Array.isArray(value)).toBe(true);
  return value as string[];
};

describe("the TerminalBench adapter project", () => {
  it("exists with its lock file", () => {
    expect(existsSync(join(repoRoot, PROJECT, "pyproject.toml"))).toBe(true);
    expect(existsSync(join(repoRoot, PROJECT, "uv.lock"))).toBe(true);
  });

  it("is not a Bun workspace package", async () => {
    const workspaces = patterns((await readJson("package.json")).workspaces);
    for (const workspace of workspaces) {
      for (const path of PROJECT_FILES) expect(new Glob(workspace).match(path)).toBe(false);
    }
    expect(existsSync(join(repoRoot, PROJECT, "package.json"))).toBe(false);
  });

  it("is outside every TypeScript project that the typecheck runs", () => {
    // The root `typecheck` script runs `bun --filter '*' typecheck`, which covers the workspace
    // packages only (see the test above), and `tsc -p scripts/tsconfig.json`. This asks tsc for
    // the files of that second project.
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        join(repoRoot, "scripts", "tsconfig.json"),
        "--listFilesOnly",
      ],
      { cwd: repoRoot },
    );
    expect(result.exitCode).toBe(0);
    const files = result.stdout.toString().trim().split(/\r?\n/);
    expect(files.some((file) => file.includes("scripts/tests/evaluation-project.test.ts"))).toBe(
      true,
    );
    expect(files.filter((file) => file.replaceAll("\\", "/").includes(`/${PROJECT}/`))).toEqual([]);
    expect(existsSync(join(repoRoot, PROJECT, "tsconfig.json"))).toBe(false);
  }, 60_000);

  it("keeps its virtual environment away from Biome", async () => {
    const files = (await readJson("biome.json")).files as { includes: unknown };
    expect(patterns(files.includes)).toContain("!**/.venv");
  });
});
