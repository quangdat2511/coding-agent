import { relative } from "node:path";
import type { RepoPath } from "@coding-agent/agent-core";

// A path or a file's text can hold any character, so every tool result that embeds one quotes it:
// this keeps a name or a matched line with a newline from passing for a separate result line.
export function quote(text: string): string {
  return JSON.stringify(text);
}

// A summary shows the target relative to the repository root, so an absolute path inside the
// repository reads the same as the relative one the model may have sent. The root itself is ".".
export function displayPath(repoRoot: RepoPath, path: RepoPath): string {
  return relative(repoRoot, path) || ".";
}

// An Approval line names the text an edit replaces and inserts, so a preview stays short enough
// for one row; the Tool Call the model sent holds the full text.
const PREVIEW_LIMIT = 40;

export function preview(text: string): string {
  if (text.length <= PREVIEW_LIMIT) return quote(text);
  const cut = text.slice(0, PREVIEW_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate alone would print as U+FFFD, so the split pair is dropped instead.
  const half = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return quote(`${half}...`);
}

// TextEncoder encodes a lone surrogate as U+FFFD (3 bytes), matching what writeFile puts on disk;
// Buffer.byteLength reports the replacement differently on some runtimes.
const utf8 = new TextEncoder();

export function describeBytes(content: string): string {
  const bytes = utf8.encode(content).byteLength;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}
