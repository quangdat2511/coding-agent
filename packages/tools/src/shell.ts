import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

// What finding a shell needs from the host. processShellHost reads this process; tests pass their
// own host so the Windows search runs on every platform.
export interface ShellHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether path names a file this process can run. */
  isExecutable(path: string): boolean;
}

export type ShellLookup =
  | { readonly ok: true; readonly shell: string }
  | { readonly ok: false; readonly message: string };

// bash runs commands through a POSIX shell on every platform, as Pi does. On Windows that is Git
// Bash: the standard install locations first, then the first bash.exe on PATH that is not WSL's.
// WSL's bash.exe runs commands in a Linux distribution rather than against this Windows checkout,
// and it usually comes first on PATH because System32 does.
export function findShell(host: ShellHost): ShellLookup {
  if (host.platform !== "win32") {
    const shell = onPath(host, "bash")[0] ?? (host.isExecutable("/bin/sh") ? "/bin/sh" : null);
    return shell === null
      ? { ok: false, message: "no shell found: neither bash on PATH nor /bin/sh exists" }
      : { ok: true, shell };
  }

  const roots = [host.env.ProgramFiles, host.env["ProgramFiles(x86)"]];
  const installs = roots
    .filter((root): root is string => root !== undefined && root !== "")
    .map((root) => win32.join(root, "Git", "bin", "bash.exe"));
  if (host.env.LOCALAPPDATA) {
    installs.push(win32.join(host.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  const shell =
    installs.find((path) => host.isExecutable(path)) ??
    onPath(host, "bash.exe").find((path) => !isWslLauncher(path));
  return shell === undefined
    ? {
        ok: false,
        message:
          "no shell found: install Git for Windows so Git Bash is available, " +
          "or put its bash.exe on PATH (WSL's bash.exe is not used)",
      }
    : { ok: true, shell };
}

// Every executable named command on PATH, in PATH order.
function onPath(host: ShellHost, command: string): string[] {
  const { delimiter, join } = host.platform === "win32" ? win32 : posix;
  // Windows environment names are case-insensitive, and the variable is often spelled Path.
  const path = host.env.PATH ?? host.env.Path ?? "";
  return path
    .split(delimiter)
    .filter((directory) => directory !== "")
    .map((directory) => join(directory, command))
    .filter((candidate) => host.isExecutable(candidate));
}

// WSL installs bash.exe in System32 and as an app execution alias under WindowsApps.
function isWslLauncher(path: string): boolean {
  const normalized = path.replaceAll(posix.sep, win32.sep).toLowerCase();
  return normalized.endsWith("\\system32\\bash.exe") || normalized.includes("\\windowsapps\\");
}

// This process as a ShellHost. It searches PATH itself rather than through the Bun global, which
// tools may use only inside the child launcher (CDA-68); a lookup starts no child.
export function processShellHost(): ShellHost {
  return {
    platform: process.platform,
    env: process.env,
    isExecutable: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        if (process.platform !== "win32") accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
