import type { PathResolution, RepoPath, WorkspaceResolver } from "../../src/index.ts";

export interface FakeWorkspaceOptions {
  readonly repoRoot?: string;
  readonly existing?: readonly string[];
}

export function fakeWorkspace({
  repoRoot = "/repo",
  existing = [],
}: FakeWorkspaceOptions = {}): WorkspaceResolver {
  const root = repoRoot as RepoPath;
  const paths = new Set([root, ...existing.map((input) => join(root, input))]);

  const resolve = (input: string, mustExist: boolean): PathResolution => {
    const path = join(root, input);
    if (path !== root && !path.startsWith(`${root}/`)) {
      return {
        ok: false,
        code: "PATH_OUTSIDE_REPO",
        message: `${input} is outside the repository`,
      };
    }
    if (mustExist && !paths.has(path)) {
      return { ok: false, code: "NOT_FOUND", message: `${input} does not exist` };
    }
    return { ok: true, path: path as RepoPath };
  };

  return {
    repoRoot: root,
    resolveExisting: async (input) => resolve(input, true),
    resolveForCreate: async (input) => resolve(input, false),
  };
}

function join(root: string, input: string): string {
  const segments = input.startsWith("/") ? [] : root.split("/").filter(Boolean);
  for (const segment of input.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
