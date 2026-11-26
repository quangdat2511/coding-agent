import { posix, win32 } from "node:path";
import type { RepoPath } from "@coding-agent/agent-core";

// A path or a file's text can hold any character, so every tool result that embeds one quotes it:
// this keeps a name or a matched line with a newline from passing for a separate result line.
export function quote(text: string): string {
  return JSON.stringify(text);
}

// A repository-relative path in a message reads the same on every platform, and the same as the
// "/"-separated path a model usually sends. POSIX keeps "\", which can be part of a file name.
export function toPortablePath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

// A summary shows the target relative to the repository root, so an absolute path inside the
// repository reads the same as the relative one the model may have sent. The root itself is ".".
// The optional platform is a test seam; callers use the current one.
export function displayPath(
  repoRoot: RepoPath,
  path: RepoPath,
  platform: NodeJS.Platform = process.platform,
): string {
  const { relative } = platform === "win32" ? win32 : posix;
  return toPortablePath(relative(repoRoot, path), platform) || ".";
}

// TextEncoder encodes a lone surrogate as U+FFFD (3 bytes), matching what writeFile puts on disk;
// Buffer.byteLength reports the replacement differently on some runtimes.
const utf8 = new TextEncoder();

export function describeBytes(content: string): string {
  const bytes = utf8.encode(content).byteLength;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}
