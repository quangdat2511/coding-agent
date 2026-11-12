import { describe, expect, it } from "bun:test";
import { findShell, type ShellHost } from "../src/shell.ts";

function host(
  platform: NodeJS.Platform,
  executables: readonly string[],
  env: Record<string, string> = {},
): ShellHost {
  return { platform, env, isExecutable: (path) => executables.includes(path) };
}

describe("finding a shell on Linux and macOS", () => {
  it("uses the first bash on PATH", () => {
    const found = findShell(
      host("linux", ["/bin/sh", "/usr/bin/bash", "/opt/bin/bash"], {
        PATH: "/usr/local/bin:/usr/bin:/opt/bin",
      }),
    );

    expect(found).toEqual({ ok: true, shell: "/usr/bin/bash" });
  });

  it("falls back to /bin/sh when bash is not on PATH", () => {
    expect(findShell(host("darwin", ["/bin/sh"], { PATH: "/usr/bin" }))).toEqual({
      ok: true,
      shell: "/bin/sh",
    });
  });

  it("fails when there is no shell at all", () => {
    expect(findShell(host("linux", [], { PATH: "/usr/bin" }))).toEqual({
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
  const wslBash = "C:\\Windows\\System32\\bash.exe";

  it("prefers the standard Git for Windows install over PATH", () => {
    const found = findShell(
      host("win32", ["C:\\Program Files\\Git\\bin\\bash.exe", "D:\\tools\\bash.exe"], {
        ...env,
        PATH: "D:\\tools",
      }),
    );

    expect(found).toEqual({ ok: true, shell: "C:\\Program Files\\Git\\bin\\bash.exe" });
  });

  it("finds a per-user Git install", () => {
    const userBash = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";

    expect(findShell(host("win32", [userBash], env))).toEqual({ ok: true, shell: userBash });
  });

  it("uses a Git bash.exe found on PATH after WSL's", () => {
    const portable = "D:\\PortableGit\\bin\\bash.exe";
    const found = findShell(
      host("win32", [wslBash, portable], {
        ...env,
        Path: "C:\\Windows\\System32;D:\\PortableGit\\bin",
      }),
    );

    expect(found).toEqual({ ok: true, shell: portable });
  });

  it("never uses WSL's bash.exe", () => {
    const appAlias = "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe";
    const found = findShell(
      host("win32", [wslBash, appAlias], {
        ...env,
        PATH: "C:\\Windows\\System32;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps",
      }),
    );

    expect(found.ok).toBe(false);
  });

  it("tells the user to install Git for Windows when no Git Bash is found", () => {
    expect(findShell(host("win32", [], env))).toEqual({
      ok: false,
      message:
        "no shell found: install Git for Windows so Git Bash is available, " +
        "or put its bash.exe on PATH (WSL's bash.exe is not used)",
    });
  });
});
