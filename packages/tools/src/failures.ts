import type { RepoPath, ToolError } from "@coding-agent/agent-core";
import { quote } from "./messages.ts";

// Failures more than one tool reports in the same words. Agent Core owns the Tool Error shape, so
// these build that type directly instead of a tool-local copy of it.
export function symbolicLinkFailure(path: RepoPath): ToolError {
  return {
    code: "PATH_OUTSIDE_REPO",
    message: `${quote(path)} is a symbolic link; symbolic links are not followed`,
  };
}

export function directoryFailure(path: RepoPath): ToolError {
  return { code: "IS_DIRECTORY", message: `${quote(path)} is a directory` };
}

export function notRegularFileFailure(path: RepoPath): ToolError {
  return { code: "PERMISSION_DENIED", message: `${quote(path)} is not a regular file` };
}
