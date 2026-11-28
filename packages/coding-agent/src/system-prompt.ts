// The system prompt every Agent Run starts from (ADR 0003 §1 and §2). Agent Core takes it as a
// string, because reading the Project Instructions is filesystem I/O that it excludes (ADR 0004 §7).
// Nothing else about the repository is read here: the model discovers its structure on demand
// through its tools, and an eager scan is rejected by ADR 0003 §1.
import * as nodeFs from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  ExecutableTool,
  OpenRunResult,
  PathResolution,
  RepoPath,
  ToolRegistry,
  WorkspaceResolver,
} from "@coding-agent/agent-core";
import { errnoOf, READ_OPEN_FLAGS } from "@coding-agent/tools";
import { type ReadableHandle, readAtMost } from "./files.ts";

// The files that can hold Project Instructions, in precedence order. Discovery stops at the first
// one found, so a CLAUDE.md that mirrors AGENTS.md is not packaged twice.
export const PROJECT_INSTRUCTIONS_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export type ProjectInstructionsFile = (typeof PROJECT_INSTRUCTIONS_FILES)[number];

// The cap on the packaged Project Instructions, the truncation marker included.
export const MAX_PROJECT_INSTRUCTIONS_BYTES = 32_768;

export const PROJECT_INSTRUCTIONS_TRUNCATION_MARKER = "\n[...project instructions truncated...]\n";

export interface ProjectInstructions {
  // The file the content was read from, relative to the Repository Root with "/" separators. It
  // names the link's target when the candidate is a link.
  readonly path: string;
  // At most MAX_PROJECT_INSTRUCTIONS_BYTES UTF-8 bytes, the truncation marker included.
  readonly content: string;
  readonly truncated: boolean;
}

// A candidate that exists but was passed over, with the reason, so the Agent Run factory can report
// it instead of dropping the file without a word.
export interface SkippedProjectInstructions {
  readonly path: ProjectInstructionsFile;
  readonly reason: string;
}

// The same failure shape openAgentRun reports, so the Agent Run factory can refuse to open an
// Agent Run with one exit code for every construction failure.
export type SystemPromptFailure = Extract<OpenRunResult, { ok: false }> & {
  readonly field: "systemPrompt";
};

export type DiscoverProjectInstructionsResult =
  | {
      readonly ok: true;
      readonly instructions: ProjectInstructions | null;
      readonly skipped: readonly SkippedProjectInstructions[];
    }
  | SystemPromptFailure;

export type AssembleSystemPromptResult =
  | {
      readonly ok: true;
      readonly systemPrompt: string;
      readonly instructions: ProjectInstructions | null;
      readonly skipped: readonly SkippedProjectInstructions[];
    }
  | SystemPromptFailure;

// The filesystem operations discovery needs. Tests pass a fake to record what is opened and to
// simulate failures, such as EACCES, that a process running as root cannot produce.
export interface InstructionsFileSystem {
  open(path: RepoPath, flags: number): Promise<InstructionsHandle>;
  // Only a candidate file at the Repository Root is read this way, to follow it as a link.
  readlink(path: string): Promise<string>;
}

export interface InstructionsHandle extends ReadableHandle {
  stat(): Promise<{ isFile(): boolean }>;
  close(): Promise<void>;
}

const encoder = new TextEncoder();
// Not fatal: a byte that is not valid becomes U+FFFD, as it does for the read tool. Each decoder
// drops its own byte order mark. The "utf-16" label is little-endian.
const utf8 = new TextDecoder("utf-8");
const utf16le = new TextDecoder("utf-16");

const MARKER_BYTES = encoder.encode(PROJECT_INSTRUCTIONS_TRUNCATION_MARKER).byteLength;

// No more of a file than this is read. UTF-16 decodes to at least one UTF-8 byte for each 2 bytes
// after its 2-byte mark, and UTF-8 decoding keeps every byte or replaces it with the 3-byte U+FFFD
// and only drops a leading 3-byte mark. So a file longer than this still decodes past the cap and
// packages as truncated. A code point that the limit splits lies past the cut.
const READ_LIMIT = 2 * MAX_PROJECT_INSTRUCTIONS_BYTES + 4;

// Git writes a symbolic link as a plain file that holds the link's target, with no newline, where
// it cannot create links, as on Windows without the privilege (core.symlinks=false).
const MAX_LINK_TARGET_BYTES = 4096;

// A `<` that opens or closes one of the wrapper tags, which the content must not end early.
const WRAPPER_TAG = /<(?=\/?project_(?:context|instructions)\b)/gi;

// Caps decoded Project Instructions at MAX_PROJECT_INSTRUCTIONS_BYTES UTF-8 bytes. A `<` that
// starts a wrapper tag becomes `&lt;` first, so the cap covers the escaped form. Content over the
// cap is cut at the last code point boundary that leaves room for the marker, and the marker is
// appended.
export function packageProjectInstructions(text: string): {
  readonly content: string;
  readonly truncated: boolean;
} {
  const escaped = text.replace(WRAPPER_TAG, "&lt;");
  const bytes = encoder.encode(escaped);
  if (bytes.byteLength <= MAX_PROJECT_INSTRUCTIONS_BYTES) {
    return { content: escaped, truncated: false };
  }
  let cut = MAX_PROJECT_INSTRUCTIONS_BYTES - MARKER_BYTES;
  // A continuation byte (0b10xxxxxx) never starts a code point, so the cut moves back past them.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return {
    content: utf8.decode(bytes.subarray(0, cut)) + PROJECT_INSTRUCTIONS_TRUNCATION_MARKER,
    truncated: true,
  };
}

export function discoverProjectInstructions(
  workspace: WorkspaceResolver,
): Promise<DiscoverProjectInstructionsResult> {
  return discoverProjectInstructionsWith(workspace, nodeFs);
}

// A candidate counts as found when it is a regular file that the Path Jail lets the read tool
// open, or a link to one. A missing candidate is passed over silently. A directory, an empty file,
// or a link that leads nowhere usable is passed over with a note in `skipped`. A file that is found
// but cannot be read ends discovery with a failure, because the Agent Run could not follow its
// conventions.
export async function discoverProjectInstructionsWith(
  workspace: WorkspaceResolver,
  fs: InstructionsFileSystem,
): Promise<DiscoverProjectInstructionsResult> {
  const skipped: SkippedProjectInstructions[] = [];
  for (const name of PROJECT_INSTRUCTIONS_FILES) {
    const found = await findCandidate(workspace, fs, name);
    if (found.kind === "absent") continue;
    if (found.kind === "failure") return unreadable(name, found.reason);
    if (found.kind !== "file") {
      skipped.push({ path: name, reason: found.reason });
      continue;
    }
    const path = shownPath(workspace.repoRoot, found.path);
    const text = decode(found.bytes);
    // An empty file holds no instructions, so the next candidate still gets its turn.
    if (text.trim() === "") {
      skipped.push({ path: name, reason: `${quote(path)} is empty` });
      continue;
    }
    return { ok: true, instructions: { path, ...packageProjectInstructions(text) }, skipped };
  }
  return { ok: true, instructions: null, skipped };
}

// What one path holds, as far as discovery is concerned.
type Opened =
  | { readonly kind: "file"; readonly path: RepoPath; readonly bytes: Uint8Array }
  // Nothing exists at the path.
  | { readonly kind: "absent"; readonly reason: string }
  // The Path Jail refused the path: it is or passes through a symbolic link, or it lies outside.
  | { readonly kind: "refused"; readonly reason: string }
  // Something exists at the path, but it is not a regular file.
  | { readonly kind: "unusable"; readonly reason: string }
  | { readonly kind: "failure"; readonly reason: string };

// Opens one candidate. The Path Jail refuses a symbolic link, so a link is followed here instead:
// its target goes through the jail like any path the model gives, and a target outside the
// repository is never read. One hop only, as the jail refuses a link to a link.
async function findCandidate(
  workspace: WorkspaceResolver,
  fs: InstructionsFileSystem,
  name: ProjectInstructionsFile,
): Promise<Opened> {
  const opened = await openInJail(workspace, fs, name);
  if (opened.kind === "refused") {
    const target = await readLink(fs, join(workspace.repoRoot, name));
    if (target === undefined) return opened;
    const followed = await openInJail(workspace, fs, target);
    switch (followed.kind) {
      case "file":
        return followed;
      case "failure":
        return linkFailure(target, followed.reason);
      default:
        return { kind: "refused", reason: `${quote(name)} is a link, and ${followed.reason}` };
    }
  }
  if (opened.kind === "file") {
    const target = linkPlaceholderTarget(opened.bytes);
    if (target === undefined) return opened;
    // A one-line file that names another regular file is the link git could not create. Any other
    // one-line file is ordinary instructions.
    const followed = await openInJail(workspace, fs, target);
    if (followed.kind === "file" && followed.path !== opened.path) return followed;
    if (followed.kind === "failure") return linkFailure(target, followed.reason);
  }
  return opened;
}

async function openInJail(
  workspace: WorkspaceResolver,
  fs: InstructionsFileSystem,
  input: string,
): Promise<Opened> {
  let resolved: PathResolution;
  try {
    resolved = await workspace.resolveExisting(input);
  } catch (error) {
    // The resolver rethrows a failure it does not expect, such as EIO.
    return { kind: "failure", reason: describe(error) };
  }
  if (!resolved.ok) {
    switch (resolved.code) {
      case "NOT_FOUND":
        return { kind: "absent", reason: resolved.message };
      case "PERMISSION_DENIED":
        return { kind: "failure", reason: "permission denied" };
      default:
        return { kind: "refused", reason: resolved.message };
    }
  }
  return readCandidate(fs, resolved.path, quote(input));
}

// Opens before checking the file's type, so the check applies to the file actually read.
async function readCandidate(
  fs: InstructionsFileSystem,
  path: RepoPath,
  shown: string,
): Promise<Opened> {
  let handle: InstructionsHandle;
  try {
    handle = await fs.open(path, READ_OPEN_FLAGS);
  } catch (error) {
    switch (errnoOf(error)) {
      // The file was removed after resolution.
      case "ENOENT":
      case "ENOTDIR":
        return { kind: "absent", reason: `${shown} does not exist` };
      // It became a symbolic link after resolution, or it is a directory or a socket.
      case "ELOOP":
      case "EISDIR":
      case "ENXIO":
        return { kind: "unusable", reason: `${shown} is not a regular file` };
      default:
        return { kind: "failure", reason: describe(error) };
    }
  }
  try {
    if (!(await handle.stat()).isFile()) {
      return { kind: "unusable", reason: `${shown} is not a regular file` };
    }
    return { kind: "file", path, bytes: await readAtMost(handle, READ_LIMIT) };
  } catch (error) {
    return { kind: "failure", reason: describe(error) };
  } finally {
    // The file was only read, so a failure to close it must not replace the outcome.
    await handle.close().catch(() => undefined);
  }
}

// The target of a symbolic link, or undefined when the path is not one (EINVAL).
async function readLink(fs: InstructionsFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readlink(path);
  } catch {
    return undefined;
  }
}

// The target a git link placeholder names, or undefined when the bytes cannot be one.
function linkPlaceholderTarget(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LINK_TARGET_BYTES) return undefined;
  if (bytes.some((byte) => byte === 0x00 || byte === 0x0a || byte === 0x0d)) return undefined;
  return utf8.decode(bytes);
}

function linkFailure(target: string, reason: string): Opened {
  return {
    kind: "failure",
    reason: `it links to ${quote(target)}, which cannot be read: ${reason}`,
  };
}

// UTF-16 with a byte order mark, as Windows PowerShell 5.1 writes, or else UTF-8.
function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16le.decode(swapBytePairs(bytes));
  return utf8.decode(bytes);
}

// Turns big-endian UTF-16 into little-endian. A last odd byte stays, and decodes as U+FFFD.
function swapBytePairs(bytes: Uint8Array): Uint8Array {
  const swapped = bytes.slice();
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped;
}

function shownPath(root: RepoPath, path: RepoPath): string {
  return relative(root, path).split(sep).join("/");
}

function quote(path: string): string {
  return JSON.stringify(path);
}

function describe(error: unknown): string {
  switch (errnoOf(error)) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

function unreadable(name: ProjectInstructionsFile, reason: string): SystemPromptFailure {
  return {
    ok: false,
    code: "INVALID_CONFIGURATION",
    field: "systemPrompt",
    message: `the Project Instructions file ${name} cannot be read: ${reason}`,
  };
}

export interface SystemPromptEnvironment {
  // The Repository Root, which every tool path is relative to.
  readonly workingDirectory: string;
  readonly platform: string;
  readonly tools: readonly Pick<ExecutableTool, "name" | "mutation">[];
}

// ADR 0003 §2's planning requirement. It names the registered mutating tools, so it never names a
// tool the model cannot call. With write, edit and bash registered, it is the ADR's text verbatim.
function planning(tools: SystemPromptEnvironment["tools"]): string {
  const mutating = tools
    .filter(({ mutation }) => mutation === "mutating")
    .map(({ name }) => `\`${name}\``);
  const named = mutating.length === 0 ? "" : ` (${mutating.join(", ")})`;
  return (
    `Before invoking any mutating tool${named}, you must analyze the objective, ` +
    "state your assumptions, and outline a numbered, step-by-step execution plan in your initial " +
    "response turn."
  );
}

const ROLE =
  "You are Coding Agent, an AI coding agent. You complete one Coding Task in one code " +
  "repository, and the tools listed below are your only way to inspect or change it.";

const DISCOVERY =
  "Nothing from the repository is loaded in advance, except its Project Instructions at the end " +
  "of this prompt when it has them. Explore its structure and read its code with your tools when " +
  "you need them.";

const SCRATCHPAD =
  "For a complex task, keep the notes and checklists that must last across turns in the " +
  "Scratchpad: the `.scratch/` directory in the repository root, for example `.scratch/plan.md`. " +
  "Write them with the `write` tool.";

const COMPLETION =
  "When the task is complete, reply without a tool call and summarize what you changed.";

// Each tool's description and parameters reach the model with its tool definition on every
// request, so the prompt names the tools without repeating them.
const TOOLS_NOTE = "Each tool's description and parameters come with its tool definition.";

const INSTRUCTIONS_INTRO =
  "The repository's Project Instructions follow. They describe its conventions: follow them.";

const ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\n": "&#10;",
  "\r": "&#13;",
};

// A link's target can hold any character, so the path attribute is escaped.
export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"\n\r]/g, (character) => ATTRIBUTE_ENTITIES[character] ?? character);
}

// Builds the prompt from what discovery found. It reads nothing, so the same inputs always give
// the same prompt, which run.json records.
export function buildSystemPrompt(
  { workingDirectory, platform, tools }: SystemPromptEnvironment,
  instructions: ProjectInstructions | null,
): string {
  const sections = [
    ROLE,
    planning(tools),
    DISCOVERY,
    SCRATCHPAD,
    COMPLETION,
    ["# Tools", "", ...tools.map(({ name }) => `- ${name}`), "", TOOLS_NOTE].join("\n"),
    [
      "# Environment",
      "",
      `Working directory: ${workingDirectory} (the repository root; tool paths are relative to it)`,
      `Platform: ${platform}`,
    ].join("\n"),
  ];
  if (instructions !== null) {
    sections.push(
      INSTRUCTIONS_INTRO,
      [
        "<project_context>",
        `<project_instructions path="${escapeAttribute(instructions.path)}">`,
        instructions.content,
        "</project_instructions>",
        "</project_context>",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

export interface SystemPromptSources {
  readonly workspace: WorkspaceResolver;
  readonly tools: ToolRegistry;
  // The host platform, such as process.platform.
  readonly platform: string;
}

// The one entry point the Agent Run factory calls: discovers the Project Instructions and builds
// the prompt around the registered tools.
export async function assembleSystemPrompt({
  workspace,
  tools,
  platform,
}: SystemPromptSources): Promise<AssembleSystemPromptResult> {
  const found = await discoverProjectInstructions(workspace);
  if (!found.ok) return found;
  const environment = { workingDirectory: workspace.repoRoot, platform, tools: tools.list() };
  return {
    ok: true,
    systemPrompt: buildSystemPrompt(environment, found.instructions),
    instructions: found.instructions,
    skipped: found.skipped,
  };
}
