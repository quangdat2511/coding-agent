import * as nodeFs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathResolution, RepoPath, WorkspaceResolver } from "@coding-agent/agent-core";

export type CreateWorkspaceResult =
  | { readonly ok: true; readonly workspace: WorkspaceResolver }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly message: string;
      readonly field: "repoRoot";
    };

// The filesystem operations the resolver needs. Not exported from the package: it lets tests
// simulate failures, such as EACCES, that a process running as root cannot produce.
export interface WorkspaceFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export function createWorkspaceResolver(repoRoot: string): Promise<CreateWorkspaceResult> {
  return createWorkspaceResolverWith(repoRoot, nodeFs);
}

export async function createWorkspaceResolverWith(
  repoRoot: string,
  fs: WorkspaceFileSystem,
): Promise<CreateWorkspaceResult> {
  if (repoRoot === "") return invalidRoot("repoRoot must not be empty");
  let root: RepoPath;
  try {
    root = (await fs.realpath(resolve(repoRoot))) as RepoPath;
    if (!(await fs.stat(root)).isDirectory()) {
      return invalidRoot(`repoRoot ${repoRoot} is not a directory`);
    }
  } catch (error) {
    return invalidRoot(`repoRoot ${repoRoot} cannot be opened: ${describe(error)}`);
  }
  return {
    ok: true,
    workspace: {
      repoRoot: root,
      resolveExisting: async (input) => {
        const target = locate(root, input);
        if (!target.ok) return target;
        try {
          const walked = await walk(fs, root, target.path, false);
          if (walked.link !== undefined) return linked(walked.link);
          return contain(root, input, await fs.realpath(target.path));
        } catch (error) {
          return unreachable(input, error);
        }
      },
      resolveForCreate: async (input) => {
        const target = locate(root, input);
        if (!target.ok) return target;
        if (target.path === root) return outside("the repository root cannot be created");
        try {
          const walked = await walk(fs, root, target.path, true);
          if (walked.link !== undefined) return linked(walked.link);
          const parent = await fs.realpath(join(root, ...walked.existing));
          return contain(root, input, join(parent, ...walked.missing));
        } catch (error) {
          return unreachable(input, error);
        }
      },
    },
  };
}

// Containment is checked on the lexically normalized path before the filesystem is touched, so a
// path outside the root is refused without revealing whether it exists.
function locate(root: RepoPath, input: string): PathResolution {
  if (input.includes("\0")) return outsideRoot(input);
  return contain(root, input, resolve(root, input));
}

// Applied again to the canonical path, in case a symbolic link appeared after the walk.
function contain(root: RepoPath, input: string, path: string): PathResolution {
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return outsideRoot(input);
  }
  return { ok: true, path: path as RepoPath };
}

function outsideRoot(input: string): PathResolution {
  return outside(`${JSON.stringify(input)} is outside the repository root`);
}

interface Walk {
  readonly link?: string;
  readonly existing: readonly string[];
  readonly missing: readonly string[];
}

// Walks the components below the root with lstat; the root's own ancestors were canonicalized once.
// When creating, the walk stops at the first missing component: what precedes it is the deepest
// existing parent, and a regular file there is left for the write itself to fail on.
async function walk(
  fs: WorkspaceFileSystem,
  root: RepoPath,
  path: string,
  creating: boolean,
): Promise<Walk> {
  const segments = relative(root, path)
    .split(sep)
    .filter((segment) => segment !== "");
  for (let index = 0; index < segments.length; index++) {
    const existing = segments.slice(0, index + 1);
    try {
      if ((await fs.lstat(join(root, ...existing))).isSymbolicLink()) {
        return { link: existing.join("/"), existing, missing: [] };
      }
    } catch (error) {
      if (!creating || !isMissing(error)) throw error;
      return { existing: segments.slice(0, index), missing: segments.slice(index) };
    }
  }
  return { existing: segments, missing: [] };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const notFoundCodes = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

// Maps the expected filesystem failures to the port's codes; anything else is rethrown so the
// calling tool reports TOOL_INTERNAL_ERROR.
function unreachable(input: string, error: unknown): PathResolution {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && notFoundCodes.has(code)) {
    return { ok: false, code: "NOT_FOUND", message: `${JSON.stringify(input)} does not exist` };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      message: `${JSON.stringify(input)} cannot be reached: permission denied`,
    };
  }
  if (code === "ELOOP") return outside(`${JSON.stringify(input)} loops through symbolic links`);
  throw error;
}

function linked(link: string): PathResolution {
  return outside(`"${link}" is a symbolic link; symbolic links are not followed`);
}

function outside(message: string): PathResolution {
  return { ok: false, code: "PATH_OUTSIDE_REPO", message };
}

function invalidRoot(message: string): CreateWorkspaceResult {
  return { ok: false, code: "INVALID_CONFIGURATION", message, field: "repoRoot" };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
