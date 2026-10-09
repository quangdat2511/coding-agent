import type { PathResolution, RepoPath, WorkspaceResolver } from "../../src/index.ts";

export interface FakeWorkspaceOptions {
  readonly repoRoot?: string;
  readonly existing?: readonly string[];
}

interface Location {
  readonly drive: string;
  readonly segments: readonly string[];
}

export function fakeWorkspace({
  repoRoot = "/repo",
  existing = [],
}: FakeWorkspaceOptions = {}): WorkspaceResolver {
  const windows = /^[A-Za-z]:/.test(repoRoot);
  const separator = repoRoot.includes("\\") ? "\\" : "/";
  const locate = (input: string, base: Location) => locateIn(input, base, windows);
  const root = locate(repoRoot, { drive: "", segments: [] });
  const format = ({ drive, segments }: Location) =>
    `${drive}${separator}${segments.join(separator)}` as RepoPath;
  const paths = new Set([format(root), ...existing.map((input) => format(locate(input, root)))]);

  const resolve = (input: string, mustExist: boolean): PathResolution => {
    const location = locate(input, root);
    const inside =
      location.drive === root.drive &&
      root.segments.every((segment, index) => location.segments[index] === segment);
    if (!inside) {
      return {
        ok: false,
        code: "PATH_OUTSIDE_REPO",
        message: `${input} is outside the repository`,
      };
    }
    const path = format(location);
    if (mustExist && !paths.has(path)) {
      return { ok: false, code: "NOT_FOUND", message: `${input} does not exist` };
    }
    return { ok: true, path };
  };

  return {
    repoRoot: format(root),
    resolveExisting: async (input) => resolve(input, true),
    resolveForCreate: async (input) => resolve(input, false),
  };
}

function locateIn(input: string, base: Location, windows: boolean): Location {
  const normalized = windows ? input.replaceAll("\\", "/") : input;
  const drive = windows ? /^[A-Za-z]:/.exec(normalized)?.[0] : undefined;
  const rest = drive === undefined ? normalized : normalized.slice(drive.length);
  const segments = drive !== undefined || rest.startsWith("/") ? [] : [...base.segments];
  for (const segment of rest.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return { drive: drive?.toUpperCase() ?? base.drive, segments };
}
