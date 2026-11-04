import { quote } from "./messages.ts";

// A write or edit target must name a file: it cannot end with "/" or "\", and its final component
// cannot be "." or "..". Both separators are covered so a Windows model path follows the same
// rule. The negative lookaheads keep it expressible in the JSON Schema handed to the model as well
// as in checkInput.
export const FILE_PATH_PATTERN = /^(?!.*[\\/]\.?$)(?!\.{1,2}$)(?!.*[\\/]\.{1,2}$).+$/;

// Schema Validation belongs to Agent Core (ADR 0001 §1), but the schema cannot say everything the
// tool needs, so prepare repeats the rule before it resolves anything.
export function checkFilePath(path: unknown): string | undefined {
  if (typeof path !== "string" || !FILE_PATH_PATTERN.test(path)) {
    return `path ${quote(String(path))} must be a non-empty path that names a file, not a directory`;
  }
  return undefined;
}

// Git Bash, MSYS, Cygwin, and WSL spell a Windows drive path as "/c/..." or "/mnt/c/...".
// Convert those spellings before resolving them, as Pi does, so a model or a Windows shell can
// hand the tools either form. The optional platform is a test seam; callers use the current one.
export function normalizeWindowsShellPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return input;
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) return input;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(input);
  if (match === null) return input;
  const drive = match[1];
  if (drive === undefined) return input;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}

// A trailing separator or "/." asks for a directory, as it does in a POSIX path. Windows treats
// "/" and "\" as separators; POSIX treats only "/" as one.
export function namesDirectory(
  input: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    const normalized = input.replaceAll("/", "\\");
    return normalized.endsWith("\\") || normalized.endsWith("\\.");
  }
  return input.endsWith("/") || input.endsWith("/.");
}
