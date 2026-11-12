import { describe, expect, it } from "bun:test";
import { findShell, type ShellHost } from "../src/shell.ts";

function host(
  platform: NodeJS.Platform,
  files: readonly string[],
  onPath: Record<string, string> = {},
  env: Record<string, string> = {},
): ShellHost {
  return {
    platform,
    env,
    exists: (path) => files.includes(path),
    which: (command) => onPath[command] ?? null,
  };
}

describe("finding a shell on Linux and macOS", () => {
  it("uses bash from PATH", () => {
    expect(findShell(host("linux", ["/bin/sh"], { bash: "/usr/bin/bash" }))).toEqual({
      ok: true,
      shell: "/usr/bin/bash",
    });
  });

  it("falls back to /bin/sh when bash is not on PATH", () => {
    expect(findShell(host("darwin", ["/bin/sh"]))).toEqual({ ok: true, shell: "/bin/sh" });
  });

  it("fails when there is no shell at all", () => {
    expect(findShell(host("linux", []))).toEqual({
      ok: false,
      message: "no shell found: neither bash on PATH nor /bin/sh exists",
    });
  });
});

describe("finding Git Bash on Windows", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  };

  it("prefers the standard Git for Windows install over PATH", () => {
    const found = findShell(
      host(
        "win32",
        ["C:\\Program Files\\Git\\bin\\bash.exe"],
        { "bash.exe": "D:\\tools\\bash.exe" },
        env,
      ),
    );

    expect(found).toEqual({ ok: true, shell: "C:\\Program Files\\Git\\bin\\bash.exe" });
  });

  it("finds a per-user Git install", () => {
    const userBash = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";

    expect(findShell(host("win32", [userBash], {}, env))).toEqual({ ok: true, shell: userBash });
  });

  it("uses a bash.exe on PATH when Git is installed elsewhere", () => {
    expect(
      findShell(host("win32", [], { "bash.exe": "D:\\PortableGit\\bin\\bash.exe" }, env)),
    ).toEqual({ ok: true, shell: "D:\\PortableGit\\bin\\bash.exe" });
  });

  it("skips WSL's bash.exe, which would run the command in Linux", () => {
    for (const wsl of [
      "C:\\Windows\\System32\\bash.exe",
      "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
    ]) {
      const found = findShell(host("win32", [], { "bash.exe": wsl }, env));
      expect(found.ok).toBe(false);
    }
  });

  it("tells the user to install Git for Windows when no Git Bash is found", () => {
    expect(findShell(host("win32", [], {}, env))).toEqual({
      ok: false,
      message:
        "no shell found: install Git for Windows so Git Bash is available, " +
        "or put its bash.exe on PATH (WSL's bash.exe is not used)",
    });
  });
});
