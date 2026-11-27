import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  OpenRunResult,
  PathResolution,
  RepoPath,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { errnoOf } from "./errno.ts";
import { toPortablePath } from "./messages.ts";
import { namesDirectory, normalizeWindowsShellPath } from "./paths.ts";

// The same failure shape openAgentRun reports, narrowed to the one field this factory checks.
export type CreateWorkspaceResult =
  | { readonly ok: true; readonly workspace: WorkspaceResolver }
  | (Extract<OpenRunResult, { ok: false }> & { readonly field: "repoRoot" });

// The filesystem operations the resolver needs. Not exported from the package: it lets tests
// simulate failures, such as EACCES, that a process running as root cannot produce.
export interface WorkspaceFileSystem {
  access(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  readdir(path: string): Promise<string[]>;
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
  const given = resolve(normalizeWindowsShellPath(repoRoot));
  let root: RepoPath;
  try {
    root = (await fs.realpath(given)) as RepoPath;
    if (!(await fs.stat(root)).isDirectory()) {
      return invalidRoot(`repoRoot ${repoRoot} is not a directory`);
    }
    await fs.access(root, constants.R_OK | constants.X_OK);
  } catch (error) {
    return invalidRoot(`repoRoot ${repoRoot} cannot be opened: ${describe(error)}`);
  }
  const jail: Jail = { fs, root, given };
  return {
    ok: true,
    workspace: {
      repoRoot: root,
      resolveExisting: (input) => resolvePath(jail, input, "existing"),
      resolveForCreate: (input) => resolvePath(jail, input, "create"),
    },
  };
}

interface Jail {
  readonly fs: WorkspaceFileSystem;
  // The canonical Repository Root.
  readonly root: RepoPath;
  // The root as the caller spelled it, which may pass through a symbolic link above the root.
  readonly given: string;
}

type Mode = "existing" | "create";

async function resolvePath(jail: Jail, input: string, mode: Mode): Promise<PathResolution> {
  const target = locate(jail, input);
  if (!target.ok) return target;
  if (mode === "create" && target.path === jail.root) {
    return outside("the repository root cannot be created");
  }
  try {
    const walked = await walk(jail, target.path);
    if (walked.link !== undefined) return linked(input, walked.link);
    if (walked.file !== undefined) return notDirectory(input, walked.file);
    if (mode === "existing" && walked.missing.length > 0) return notFound(input, "does not exist");
    if (walked.missing.length === 0 && target.directory && !walked.isDirectory) {
      return notDirectory(input, toPortablePath(join(...walked.existing)));
    }
    // Every component was checked with lstat, so the canonical form of the deepest existing one is
    // itself; anything else means a symbolic link appeared after the walk. Comparing for equality
    // also refuses an input whose case differs from the name on disk on a case-insensitive
    // filesystem such as macOS's default, which is accepted as stricter than needed.
    // This narrows but does not close the race: the filesystem can still change between
    // resolution and the tool opening the path. `read` opens the final component with O_NOFOLLOW,
    // but a parent directory can still be swapped for a symbolic link, since tools do not openat
    // relative to a held directory. ADR 0004 has execute re-resolve to keep that window small.
    const reached = join(jail.root, ...walked.existing);
    if (!(await isCanonical(jail, reached, walked.isDirectory))) {
      return outside(
        `${quote(input)} changed while being resolved; symbolic links are not followed`,
      );
    }
    return { ok: true, path: target.path };
  } catch (error) {
    return unreachable(input, error);
  }
}

// realpath on macOS and Windows opens the path, which fails for a file this process cannot read
// and for a socket. Such a file is checked through its canonical parent, its exact name in that
// directory, and a fresh lstat instead, so readability stays the opening tool's check.
const UNOPENABLE = new Set(["EACCES", "EPERM", "EOPNOTSUPP"]);

async function isCanonical(jail: Jail, path: string, isDirectory: boolean): Promise<boolean> {
  try {
    return (await jail.fs.realpath(path)) === path;
  } catch (error) {
    if (isDirectory || !UNOPENABLE.has(errnoOf(error) ?? "")) throw error;
  }
  const parent = dirname(path);
  if ((await jail.fs.realpath(parent)) !== parent) return false;
  if (!(await jail.fs.readdir(parent)).includes(basename(path))) return false;
  return !(await jail.fs.lstat(path)).isSymbolicLink();
}

type Located =
  | { readonly ok: true; readonly path: RepoPath; readonly directory: boolean }
  | Extract<PathResolution, { ok: false }>;

// Containment is checked on the lexically normalized path before the filesystem is touched, so a
// path outside the root is refused without revealing whether it exists. An absolute path spelled
// through the root as given is moved onto the canonical root first.
function locate(jail: Jail, input: string): Located {
  if (input.includes("\0")) return outsideRoot(input);
  const normalized = normalizeWindowsShellPath(input);
  let path = resolve(jail.root, normalized);
  if (!within(jail.root, path) && within(jail.given, path)) {
    path = join(jail.root, relative(jail.given, path));
  }
  if (!within(jail.root, path)) return outsideRoot(input);
  // A path that names the root itself is normalized to the canonical root, which on Windows also
  // settles the drive letter's case before resolveForCreate compares against it.
  if (relative(jail.root, path) === "") path = jail.root;
  // The returned path drops a trailing separator, so resolveForCreate cannot tell a file to create
  // from a directory to create; a tool that needs that distinction must extend the port rather
  // than rely on the resolved path.
  return {
    ok: true,
    path: path as RepoPath,
    directory: namesDirectory(normalized),
  };
}

function within(base: string, path: string): boolean {
  const fromBase = relative(base, path);
  return !(fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase));
}

interface Walk {
  // The first component that is a symbolic link.
  readonly link?: string;
  // The first existing component that is not a directory but has components below it.
  readonly file?: string;
  readonly existing: readonly string[];
  readonly missing: readonly string[];
  // Whether the last existing component is a directory.
  readonly isDirectory: boolean;
}

// Walks the components below the root with lstat, stopping at the first missing one; the root's
// own ancestors were canonicalized once.
async function walk(jail: Jail, path: string): Promise<Walk> {
  const segments = relative(jail.root, path)
    .split(sep)
    .filter((segment) => segment !== "");
  let isDirectory = true;
  for (let index = 0; index < segments.length; index++) {
    const existing = segments.slice(0, index + 1);
    if (!isDirectory) {
      return {
        file: toPortablePath(join(...segments.slice(0, index))),
        existing,
        missing: [],
        isDirectory,
      };
    }
    let stats: Awaited<ReturnType<WorkspaceFileSystem["lstat"]>>;
    try {
      stats = await jail.fs.lstat(join(jail.root, ...existing));
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw error;
      return { existing: segments.slice(0, index), missing: segments.slice(index), isDirectory };
    }
    if (stats.isSymbolicLink())
      return { link: toPortablePath(join(...existing)), existing, missing: [], isDirectory };
    isDirectory = stats.isDirectory();
  }
  return { existing: segments, missing: [], isDirectory };
}

// Maps the expected filesystem failures to the port's codes; anything else is rethrown so the
// calling tool reports TOOL_INTERNAL_ERROR.
function unreachable(input: string, error: unknown): PathResolution {
  switch (errnoOf(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return notFound(input, "changed while being resolved");
    case "ENAMETOOLONG":
      return notFound(input, "is longer than the filesystem allows");
    case "EINVAL":
      // Windows rejects characters its file names cannot hold this way.
      return notFound(input, "is not a valid path on this platform");
    case "EACCES":
    case "EPERM":
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: `${quote(input)} cannot be reached: permission denied`,
      };
    case "ELOOP":
      return outside(`${quote(input)} loops through symbolic links`);
    default:
      throw error;
  }
}

// Paths come from the model, so messages bound how much of one they echo back into the context.
const QUOTED_LIMIT = 120;

function quote(text: string): string {
  if (text.length <= QUOTED_LIMIT) return JSON.stringify(text);
  const omitted = text.length - QUOTED_LIMIT;
  return `${JSON.stringify(text.slice(0, QUOTED_LIMIT))}... (${omitted} more characters)`;
}

const NOT_A_DIRECTORY = Symbol("notADirectory");

// Distinguishes a path blocked by a non-directory component (e.g. "file.ts/" or "file.ts/child")
// from a genuinely missing path, without widening PathResolution's error-code union for other tools.
export function isNotDirectoryResolution(resolution: PathResolution): boolean {
  return !resolution.ok && NOT_A_DIRECTORY in resolution;
}

function notFound(input: string, reason: string): PathResolution {
  return { ok: false, code: "NOT_FOUND", message: `${quote(input)} ${reason}` };
}

function notDirectory(input: string, component: string): PathResolution {
  const result = notFound(input, `cannot be reached: ${quote(component)} is not a directory`);
  Object.defineProperty(result, NOT_A_DIRECTORY, { value: true });
  return result;
}

function linked(input: string, link: string): PathResolution {
  return outside(
    `${quote(input)} passes through the symbolic link ${quote(link)}; symbolic links are not followed`,
  );
}

function outsideRoot(input: string): Extract<PathResolution, { ok: false }> {
  return {
    ok: false,
    code: "PATH_OUTSIDE_REPO",
    message: `${quote(input)} is outside the repository root`,
  };
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
