import type { ToolErrorCode } from "./tool-result.ts";

export type RepoPath = string & { readonly __brand: "RepoPath" };

export type PathResolution =
  | { readonly ok: true; readonly path: RepoPath }
  | {
      readonly ok: false;
      readonly code: Extract<
        ToolErrorCode,
        "PATH_OUTSIDE_REPO" | "NOT_FOUND" | "PERMISSION_DENIED"
      >;
      readonly message: string;
      readonly reason?: "not_a_directory";
    };

export interface WorkspaceResolver {
  readonly repoRoot: RepoPath;
  resolveExisting(input: string): Promise<PathResolution>;
  resolveForCreate(input: string): Promise<PathResolution>;
}
