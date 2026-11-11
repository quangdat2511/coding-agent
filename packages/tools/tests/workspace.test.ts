import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoPath, WorkspaceResolver } from "@coding-agent/agent-core";
import { createWorkspaceResolver } from "../src/index.ts";
import { createWorkspaceResolverWith, type WorkspaceFileSystem } from "../src/workspace.ts";

// Root ignores directory permissions and Windows has no POSIX ones, so those tests simulate a
// refusal.
const permissionsIgnored = process.getuid?.() === 0 || process.platform === "win32";
// Windows reports a component longer than the file system allows as missing, not ENAMETOOLONG.
const noNameTooLong = process.platform === "win32";

let sandbox: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "workspace-resolver-")));
});

afterEach(async () => {
  await chmod(join(sandbox, "repo"), 0o755).catch(() => undefined);
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

  it("refuses a Repository Root that cannot be searched", async () => {
    const repo = await makeRepo();
    const created = permissionsIgnored
      ? await createWorkspaceResolverWith(repo, {
          ...fs,
          access: async () => {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          },
        })
      : await chmod(repo, 0o600).then(() => createWorkspaceResolver(repo));

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

  it("accepts an absolute path spelled through the Repository Root as given", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const alias = join(sandbox, "alias");
    await symlink(repo, alias);
    const workspace = await resolverFor(alias);

    expect(await workspace.resolveExisting(join(alias, "a.ts"))).toEqual({
      ok: true,
      path: join(repo, "a.ts") as RepoPath,
    });
    expect(await workspace.resolveExisting(join(alias, "../outside.txt"))).toMatchObject({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
    });
  });

  it("accepts a directory named with a trailing slash", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, "src"));
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting("src/")).toEqual({
      ok: true,
      path: join(repo, "src") as RepoPath,
    });
  });

  // Whether the target can be read is left to the tool that opens it (CDA-58), which must report
  // EACCES on open anyway, since permissions can change after resolution.
  it("resolves a file it cannot read, leaving the read itself to refuse", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "secret.ts"), "");
    await chmod(join(repo, "secret.ts"), 0o000);
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting("secret.ts")).toEqual({
      ok: true,
      path: join(repo, "secret.ts") as RepoPath,
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

describe("a sibling of the Repository Root sharing its name as a prefix", () => {
  // relative() puts it at "../repo-xau/...", which a string prefix check on the root would accept.
  it.each([
    [
      "resolveExisting",
      (workspace: WorkspaceResolver, input: string) => workspace.resolveExisting(input),
    ],
    [
      "resolveForCreate",
      (workspace: WorkspaceResolver, input: string) => workspace.resolveForCreate(input),
    ],
  ])("%s rejects it as outside the repository", async (_, resolve) => {
    const repo = await makeRepo();
    await mkdir(`${repo}-xau`);
    await writeFile(`${repo}-xau/file.txt`, "");
    const workspace = await resolverFor(repo);

    expect(await resolve(workspace, `${repo}-xau/file.txt`)).toMatchObject({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
    });
  });
});

describe("resolving a path that cannot be reached", () => {
  it.each([
    ["a missing file", "missing.ts", '"missing.ts" does not exist'],
    [
      "a path below a regular file",
      "a.ts/b",
      '"a.ts/b" cannot be reached: "a.ts" is not a directory',
    ],
    [
      "a regular file named as a directory",
      "a.ts/",
      '"a.ts/" cannot be reached: "a.ts" is not a directory',
    ],
  ])("reports %s as not found", async (_, input, message) => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveExisting(input)).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message,
    });
  });

  it.skipIf(noNameTooLong).each([
    [
      "resolveExisting",
      (workspace: WorkspaceResolver, input: string) => workspace.resolveExisting(input),
    ],
    [
      "resolveForCreate",
      (workspace: WorkspaceResolver, input: string) => workspace.resolveForCreate(input),
    ],
  ])(
    "%s reports a name longer than the filesystem allows, echoing a bounded prefix",
    async (_, resolve) => {
      const repo = await makeRepo();
      const workspace = await resolverFor(repo);

      const resolution = await resolve(workspace, "x".repeat(300));

      expect(resolution).toEqual({
        ok: false,
        code: "NOT_FOUND",
        message: `"${"x".repeat(120)}"... (180 more characters) is longer than the filesystem allows`,
      });
    },
  );
});

function failingAt(path: string, code: string): WorkspaceFileSystem {
  const fail = (target: string) => {
    if (target === path || target.startsWith(`${path}/`)) {
      throw Object.assign(new Error(`${code}: ${target}`), { code });
    }
  };
  return {
    access: fs.access,
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
    const created = permissionsIgnored
      ? await createWorkspaceResolverWith(repo, failingAt(join(repo, "locked/a.ts"), "EACCES"))
      : await chmod(join(repo, "locked"), 0o000).then(() => createWorkspaceResolver(repo));
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);

    expect(await created.workspace.resolveExisting("locked/a.ts")).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    });
  });

  it("reports a path the platform considers invalid as not found", async () => {
    const repo = await makeRepo();
    const created = await createWorkspaceResolverWith(repo, {
      ...fs,
      lstat: async () => {
        throw Object.assign(new Error("EINVAL: invalid argument"), { code: "EINVAL" });
      },
    });
    if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);

    expect(await created.workspace.resolveExisting("bad:name")).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: '"bad:name" is not a valid path on this platform',
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

  describe("when realpath cannot open the file, as on macOS and Windows", () => {
    const unopenable = (
      repo: string,
      overrides: Partial<WorkspaceFileSystem> = {},
    ): WorkspaceFileSystem => ({
      ...fs,
      realpath: async (target) => {
        if (target === join(repo, "a.ts")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return (overrides.realpath ?? fs.realpath)(target);
      },
      lstat: overrides.lstat ?? fs.lstat,
    });

    async function resolveWith(repo: string, files: WorkspaceFileSystem) {
      const created = await createWorkspaceResolverWith(repo, files);
      if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
      return created.workspace.resolveExisting("a.ts");
    }

    it("resolves the file through its canonical parent", async () => {
      const repo = await makeRepo();
      await writeFile(join(repo, "a.ts"), "");

      expect(await resolveWith(repo, unopenable(repo))).toEqual({
        ok: true,
        path: join(repo, "a.ts") as RepoPath,
      });
    });

    it("rejects the file once a symbolic link is swapped in after the walk", async () => {
      const repo = await makeRepo();
      await writeFile(join(repo, "a.ts"), "");
      let calls = 0;
      const lstat: WorkspaceFileSystem["lstat"] = async (target) => {
        const stats = await fs.lstat(target);
        if (target !== join(repo, "a.ts") || ++calls === 1) return stats;
        return Object.assign(stats, { isSymbolicLink: () => true });
      };

      expect(await resolveWith(repo, unopenable(repo, { lstat }))).toMatchObject({
        ok: false,
        code: "PATH_OUTSIDE_REPO",
      });
    });

    it("rejects the file once its parent's canonical form changes after the walk", async () => {
      const repo = await makeRepo();
      await writeFile(join(repo, "a.ts"), "");
      let calls = 0;
      const realpath: WorkspaceFileSystem["realpath"] = async (target) =>
        target === repo && ++calls > 1 ? join(repo, "docs") : fs.realpath(target);

      expect(await resolveWith(repo, unopenable(repo, { realpath }))).toMatchObject({
        ok: false,
        code: "PATH_OUTSIDE_REPO",
      });
    });
  });

  it.each([
    ["resolveExisting", "a.ts", "a.ts"],
    ["resolveForCreate", "src/new.ts", "src"],
  ])(
    "%s rejects a symbolic link into the repository swapped in after the walk",
    async (method, input, swappedAt) => {
      const repo = await makeRepo();
      await mkdir(join(repo, "src"));
      await mkdir(join(repo, "docs"));
      await writeFile(join(repo, "a.ts"), "");
      await writeFile(join(repo, "docs/a.ts"), "");
      // The canonical form stays inside the root, so only comparing it to the walked path catches it.
      const swapped: WorkspaceFileSystem = {
        ...fs,
        realpath: async (target) =>
          target === join(repo, swappedAt) ? join(repo, "docs", swappedAt) : fs.realpath(target),
      };
      const created = await createWorkspaceResolverWith(repo, swapped);
      if (!created.ok) throw new Error(`expected a resolver, got: ${created.message}`);
      const workspace = created.workspace;

      const resolution =
        method === "resolveExisting"
          ? await workspace.resolveExisting(input)
          : await workspace.resolveForCreate(input);

      expect(resolution).toMatchObject({ ok: false, code: "PATH_OUTSIDE_REPO" });
    },
  );

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
    [
      "a file reached through a symbolic link pointing inside the root",
      "docs/latest/guide.md",
      "docs/latest",
    ],
    ["a symbolic link reached by an absolute path", "/leak", "leak"],
  ])("rejects %s and names the link", async (_, input, link) => {
    const repo = await makeRepo();
    await mkdir(join(sandbox, "private"));
    await writeFile(join(sandbox, "private/secret.txt"), "");
    await mkdir(join(repo, "docs/v2"), { recursive: true });
    await writeFile(join(repo, "docs/v2/guide.md"), "");
    await symlink(join(sandbox, "private/secret.txt"), join(repo, "leak"));
    await symlink(join(sandbox, "private"), join(repo, "linked"));
    await symlink(join(repo, "docs/v2"), join(repo, "docs/latest"));
    const workspace = await resolverFor(repo);

    const spelled = input.startsWith("/") ? join(repo, input) : input;

    const resolution = await workspace.resolveExisting(spelled);

    expect(resolution).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: `${JSON.stringify(spelled)} passes through the symbolic link "${link}"; symbolic links are not followed`,
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
    ["a missing directory named with a trailing slash", "new/", "new"],
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
    [
      "a path below a regular file",
      "a.ts/b/c",
      '"a.ts/b/c" cannot be reached: "a.ts" is not a directory',
    ],
    [
      "a regular file named as a directory",
      "a.ts/",
      '"a.ts/" cannot be reached: "a.ts" is not a directory',
    ],
  ])("refuses %s, whose deepest existing parent is not a directory", async (_, input, message) => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.ts"), "");
    const workspace = await resolverFor(repo);

    expect(await workspace.resolveForCreate(input)).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message,
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
