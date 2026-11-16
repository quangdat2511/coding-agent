import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { parseBuildArgs, resolveCommit, runnableTarget, TARGETS } from "../build-artifact.ts";

const head = "1c0f27d4b1e2a3c4d5e6f708192a3b4c5d6e7f80";

describe("TARGETS", () => {
  it("builds exactly the two ADR 0005 §2 targets under their file names", () => {
    expect(TARGETS.map(({ file, target }) => [file, target])).toEqual([
      ["coding-agent-linux-x64", "bun-linux-x64-baseline"],
      ["coding-agent-linux-arm64", "bun-linux-arm64"],
    ]);
  });
});

describe("runnableTarget", () => {
  it.each([
    ["linux", "x64", "coding-agent-linux-x64"],
    ["linux", "arm64", "coding-agent-linux-arm64"],
  ])("runs the %s %s executable on that host", (platform, arch, file) => {
    expect<string | undefined>(runnableTarget(platform, arch)?.file).toBe(file);
  });

  it.each([
    ["darwin", "arm64"],
    ["win32", "x64"],
    ["linux", "ia32"],
  ])("runs neither executable on %s %s", (platform, arch) => {
    expect(runnableTarget(platform, arch)).toBeUndefined();
  });
});

describe("resolveCommit", () => {
  it("names the commit of a clean working tree", () => {
    expect(resolveCommit({ head, status: "" }, false)).toEqual({
      ok: true,
      commit: head,
      dirty: false,
    });
  });

  it("refuses a dirty working tree and lists what is dirty", () => {
    const result = resolveCommit({ head, status: " M package.json\n?? notes.md\n" }, false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(" M package.json\n?? notes.md\n");
    expect(result.message).toContain("--allow-dirty");
  });

  it("marks the commit of a dirty build when it is allowed", () => {
    expect(resolveCommit({ head, status: "?? notes.md\n" }, true)).toEqual({
      ok: true,
      commit: `${head}-dirty`,
      dirty: true,
    });
  });
});

describe("parseBuildArgs", () => {
  const cwd = join("/", "work");

  it("defaults to dist/artifact in the repository and refuses a dirty tree", () => {
    const parsed = parseBuildArgs([], cwd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.outDir).toBe(join(import.meta.dir, "..", "..", "dist", "artifact"));
    expect(parsed.args.allowDirty).toBe(false);
  });

  it("resolves --out-dir against the working directory and accepts --allow-dirty", () => {
    expect(parseBuildArgs(["--out-dir", "out", "--allow-dirty"], cwd)).toEqual({
      ok: true,
      args: { outDir: resolve(cwd, "out"), allowDirty: true },
    });
  });

  it.each([
    [["--out-dir"], "--out-dir requires a value"],
    [["--out-dir", " "], "--out-dir requires a value"],
    [["--target", "bun-linux-x64"], 'unexpected argument "--target"'],
  ])("refuses %j", (argv, message) => {
    expect(parseBuildArgs(argv, cwd)).toEqual({ ok: false, message });
  });
});
