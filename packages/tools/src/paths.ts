// Git Bash, MSYS, Cygwin, and WSL spell a Windows drive path as "/c/..." or "/mnt/c/...".
// Convert those spellings before resolving them, as Pi does, so a model or a Windows shell can
// hand the tools either form.
export function normalizeWindowsShellPath(input: string): string {
  if (process.platform !== "win32") return input;
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
export function namesDirectory(input: string): boolean {
  if (process.platform === "win32") {
    const normalized = input.replaceAll("/", "\\");
    return normalized.endsWith("\\") || normalized.endsWith("\\.");
  }
  return input.endsWith("/") || input.endsWith("/.");
}
