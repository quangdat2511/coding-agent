import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join, posix, win32 } from "node:path";

// What finding a shell needs from the host. The real lookup reads the process; tests pass a host
// so the Windows search runs on every platform.
export interface ShellHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  exists(path: string): boolean;
  which(command: string): string | null;
}

export type ShellLookup =
  | { readonly ok: true; readonly shell: string }
  | { readonly ok: false; readonly message: string };

// bash runs commands through a POSIX shell on every platform, as Pi does. On Windows that is Git
// Bash: the standard install locations first, then a bash.exe on PATH. WSL's bash.exe is skipped,
// since it runs commands in a Linux distribution rather than against this Windows checkout.
export function findShell(host: ShellHost): ShellLookup {
  if (host.platform !== "win32") {
    const shell = host.which("bash") ?? (host.exists("/bin/sh") ? "/bin/sh" : null);
    return shell === null
      ? { ok: false, message: "no shell found: neither bash on PATH nor /bin/sh exists" }
      : { ok: true, shell };
  }

  const installs = [host.env.ProgramFiles, host.env["ProgramFiles(x86)"]]
    .filter((root): root is string => root !== undefined && root !== "")
    .map((root) => win32.join(root, "Git", "bin", "bash.exe"));
  const userInstall = host.env.LOCALAPPDATA;
  if (userInstall) installs.push(win32.join(userInstall, "Programs", "Git", "bin", "bash.exe"));
  const installed = installs.find((path) => host.exists(path));
  if (installed !== undefined) return { ok: true, shell: installed };

  const onPath = host.which("bash.exe");
  if (onPath !== null && !isWslLauncher(onPath)) return { ok: true, shell: onPath };
  return {
    ok: false,
    message:
      "no shell found: install Git for Windows so Git Bash is available, " +
      "or put its bash.exe on PATH (WSL's bash.exe is not used)",
  };
}

// WSL installs bash.exe in System32 and as an app execution alias under WindowsApps.
function isWslLauncher(path: string): boolean {
  const normalized = path.replaceAll(posix.sep, win32.sep).toLowerCase();
  return normalized.endsWith("\\system32\\bash.exe") || normalized.includes("\\windowsapps\\");
}

// The real host. which searches PATH itself: tools may not touch the Bun global outside the
// child launcher (CDA-68), and a lookup needs no child process.
export const hostShell: ShellHost = {
  platform: process.platform,
  env: process.env,
  exists: (path) => existsSync(path),
  which: (command) => {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (directory === "") continue;
      const candidate = join(directory, command);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable.
      }
    }
    return null;
  },
};
