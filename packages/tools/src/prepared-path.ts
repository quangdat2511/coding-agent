import type { PathResolution, RepoPath } from "@coding-agent/agent-core";
import { quote } from "./messages.ts";

// Re-validates the canonical path prepare resolved, because the filesystem may change before
// execute runs and prepare can wait for Approval in between (ADR 0004 §3). Resolving the model's
// input again instead would let execute act on a path prepare never validated, so the prepared path
// is what goes back through the resolver, and it must still resolve to itself.
export async function revalidatePreparedPath(
  paths: readonly RepoPath[],
  resolve: (path: RepoPath) => Promise<PathResolution>,
): Promise<PathResolution> {
  const prepared = paths[0];
  // The file tools prepare exactly one path; a tool that prepares several must validate each one.
  if (prepared === undefined) throw new Error("the prepared call has no path to re-validate");
  const resolved = await resolve(prepared);
  if (!resolved.ok) return resolved;
  if (resolved.path !== prepared) {
    return {
      ok: false,
      code: "PATH_OUTSIDE_REPO",
      message: `${quote(prepared)} changed after it was prepared`,
    };
  }
  return resolved;
}
