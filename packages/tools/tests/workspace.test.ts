import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoPath, WorkspaceResolver } from "@coding-agent/agent-core";
import { createWorkspaceResolver } from "../src/index.ts";
import { createWorkspaceResolverWith, type WorkspaceFileSystem } from "../src/workspace.ts";

let sandbox: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "workspace-resolver-")));
});

afterEach(async () => {
  await chmod(join(sandbox, "repo/locked"), 0o755).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const repo = join(sandbox, "repo");
  await mkdir(repo);
  return repo;
}

describe("creating a workspace resolver", () => {
  it("canonicalizes a Repository Root reached through a symbolic link", async () => {
    const repo = await makeRepo();
    const alias = join(sandbox, "alias");
    await symlink(repo, alias);

    const created = await createWorkspaceResolver(alias);

    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
    expect(created.workspace.repoRoot).toBe(repo as RepoPath);
  });

  it.each([
    ["a missing directory", (sandbox: string) => join(sandbox, "missing")],
    ["a regular file", (sandbox: string) => join(sandbox, "file.txt")],
    ["an empty string", () => ""],
  ])("refuses %s as the Repository Root", async (_, root) => {
    await writeFile(join(sandbox, "file.txt"), "");

    const created = await createWorkspaceResolver(root(sandbox));

    expect(created).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION", field: "repoRoot" });
  });
});

async function resolverFor(repo: string): Promise<WorkspaceResolver> {
  const created = await createWorkspaceResolver(repo);
  if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
  return created.workspace;
}

describe("resolving an existing path", () => {
  it("resolves a relative path to its canonical absolute path", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src/a.ts"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting("./src/../src/a.ts")).toEqual({
      ok: true,
      path: join(repo, "src/a.ts") as RepoPath,
    });
  });

  it("accepts an absolute path inside the Repository Root", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting(join(repo, "a.ts"))).toEqual({
      ok: true,
      path: join(repo, "a.ts") as RepoPath,
    });
  });

  it.each(["", "."])("resolves %j to the Repository Root itself", async (input) => {
    const repo = await makeRepo();
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting(input)).toEqual({ ok: true, path: repo as RepoPath });
  });

  it("returns a branded path that a plain string cannot stand in for", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const workspace = await resolverFor(repo);
    const readFrom = (path: RepoPath): string => path;

    const resolution = await workspace.resolveExisting("a.ts");
    if (!resolution.ok) throw new Error(`expected a path, got: ${resolution.message}`);

    expect(readFrom(resolution.path)).toBe(join(repo, "a.ts"));
    // @ts-expect-error a plain string is not a RepoPath
    readFrom(join(repo, "a.ts"));
  });

  it.each([
    ["a traversal to an existing file", "../outside.txt"],
    ["a traversal to a missing file", "../missing.txt"],
    ["an absolute path outside the root", "/etc/hostname"],
    ["a path containing a NUL byte", "a\0.ts"],
  ])("rejects %s as outside the repository before touching it", async (_, input) => {
    const repo = await makeRepo();
    await writeFile(join(sandbox, "outside.txt"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting(input)).toMatchObject({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
    });
  });
});

describe("resolving a path that cannot be reached", () => {
  it.each([
    ["a missing file", "missing.ts"],
    ["a path below a regular file", "a.ts/b"],
    ["a component longer than the filesystem allows", "x".repeat(300)],
  ])("reports %s as not found", async (_, input) => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting(input)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});

function failingAt(path: string, code: string): WorkspaceFileSystem {
  const fail = (target: string) => {
    if (target === path || target.startsWith(`${path}/`)) {
      throw Object.assign(new Error(`${code}: ${target}`), { code });
    }
  };
  return {
    stat: fs.stat,
    lstat: async (target) => {
      fail(target);
      return fs.lstat(target);
    },
    realpath: async (target) => {
      fail(target);
      return fs.realpath(target);
    },
  };
}

describe("resolving a path the filesystem refuses", () => {
  it("reports a path below a directory that cannot be searched as permission denied", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, "locked"));
    await writeFile(join(repo, "locked/a.ts"), "");
    // A process running as root ignores directory permissions, so it simulates the refusal.
    const created =
      process.getuid?.() === 0
        ? await createWorkspaceResolverWith(repo, failingAt(join(repo, "locked/a.ts"), "EACCES"))
        : await chmod(join(repo, "locked"), 0o000).then(() => createWorkspaceResolver(repo));
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);

    expect(await created.workspace.resolveExisting("locked/a.ts")).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    });
  });

  it("reports a symbolic-link loop as outside the repository", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const created = await createWorkspaceResolverWith(repo, failingAt(join(repo, "a.ts"), "ELOOP"));
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);

    expect(await created.workspace.resolveExisting("a.ts")).toMatchObject({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
    });
  });

  it("rejects a path whose canonical form lands outside the root after the walk", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    // Simulates a symbolic link swapped in between the lstat walk and canonicalization.
    const swapped: WorkspaceFileSystem = {
      ...fs,
      realpath: async (target) =>
        target === join(repo, "a.ts") ? "/etc/hostname" : fs.realpath(target),
    };
    const created = await createWorkspaceResolverWith(repo, swapped);
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);

    expect(await created.workspace.resolveExisting("a.ts")).toMatchObject({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
    });
  });

  it("rethrows an unexpected filesystem failure for the calling tool to report", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const created = await createWorkspaceResolverWith(repo, failingAt(join(repo, "a.ts"), "EIO"));
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);

    await expect(created.workspace.resolveExisting("a.ts")).rejects.toMatchObject({ code: "EIO" });
  });
});

describe("the Path Jail and symbolic links", () => {
  it.each([
    ["a symbolic link pointing outside the root", "leak", "leak"],
    ["a file reached through a symbolic-link directory", "linked/secret.txt", "linked"],
    ["a symbolic link pointing inside the root", "docs/latest", "docs/latest"],
  ])("rejects %s and names the link", async (_, input, link) => {
    const repo = await makeRepo();
    await mkdir(join(sandbox, "private"));
    await writeFile(join(sandbox, "private/secret.txt"), "");
    await mkdir(join(repo, "docs/v2"), { recursive: true });
    await symlink(join(sandbox, "private/secret.txt"), join(repo, "leak"));
    await symlink(join(sandbox, "private"), join(repo, "linked"));
    await symlink(join(repo, "docs/v2"), join(repo, "docs/latest"));
    const workspace = await resolverFor(repo);

    const resolution = await workspace.resolveExisting(input);

    expect(resolution).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: `"${link}" is a symbolic link; symbolic links are not followed`,
    });
  });
});

describe("resolving a path to create", () => {
  it("verifies the deepest existing parent and creates nothing", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, "src"));
    const workspace = await resolverFor(repo);

    const resolution = await workspace.resolveForCreate("src/new/deeper/file.ts");

    expect(resolution).toEqual({
      ok: true,
      path: join(repo, "src/new/deeper/file.ts") as RepoPath,
    });
    expect(await fs.readdir(join(repo, "src"))).toEqual([]);
  });

  it.each([
    ["an existing regular file, which the write replaces", "a.ts", "a.ts"],
    ["a path below a regular file, which the write itself refuses", "a.ts/b", "a.ts/b"],
  ])("accepts %s", async (_, input, expected) => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveForCreate(input)).toEqual({
      ok: true,
      path: join(repo, expected) as RepoPath,
    });
  });

  it.each([
    ["a symbolic link as the target", "leak"],
    ["a path below a symbolic-link directory", "linked/new.txt"],
    ["a traversal outside the root", "../new.txt"],
    ["the Repository Root itself", "."],
  ])("rejects %s as outside the repository", async (_, input) => {
    const repo = await makeRepo();
    await mkdir(join(sandbox, "private"));
    await writeFile(join(sandbox, "secret.txt"), "");
    await symlink(join(sandbox, "secret.txt"), join(repo, "leak"));
    await symlink(join(sandbox, "private"), join(repo, "linked"));
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveForCreate(input)).toMatchObject({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
    });
    expect(await fs.readdir(join(sandbox, "private"))).toEqual([]);
  });
});
