import type { PathResolution, RepoPath, WorkspaceResolver } from "@coding-agent/agent-core";
import { quote } from "./messages.ts";

// Re-validates the canonical path an Approval displayed, because waiting for Approval leaves time
// for the filesystem to change (ADR 0004 §3). Resolving the model's input again instead would let
// execute act on a path the Approval never saw, so the prepared path is what goes back through the
// resolver, and it must still resolve to itself.
export async function revalidatePreparedPath(
  workspace: WorkspaceResolver,
  paths: readonly RepoPath[],
  mode: "existing" | "create",
): Promise<PathResolution> {
  const approved = paths[0];
  // The file tools prepare exactly one path; a tool that prepares several must validate each one.
  if (approved === undefined) throw new Error("the prepared call has no path to re-validate");
  const resolved =
    mode === "existing"
      ? await workspace.resolveExisting(approved)
      : await workspace.resolveForCreate(approved);
  if (!resolved.ok) return resolved;
  if (resolved.path !== approved) {
    return {
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: `${quote(approved)} changed after it was approved`,
    };
  }
  return resolved;
}
