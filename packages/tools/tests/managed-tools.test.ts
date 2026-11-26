import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ChildProcess, ChildProcessLauncher } from "../src/child-process.ts";
import {
  compareSemver,
  createToolAcquirer,
  type DirEntry,
  type FetchFn,
  formatAcquireFailureMessage,
  isOfflineEnv,
  type ManagedToolsManifest,
  parseToolVersion,
  resolveConfiguredCacheRoot,
  resolveTargetKey,
  type ToolAcquirerFs,
} from "../src/managed-tools.ts";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (data.byteLength > 0) controller.enqueue(data);
      controller.close();
    },
  });
}

interface FakeCommandResponse {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly delayMs?: number;
  readonly throwError?: Error;
  readonly onLaunch?: (argv: readonly string[]) => void;
}

function createFakeChild(response: FakeCommandResponse): ChildProcess {
  let killed = false;
  let exitCode: number | null = null;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const finish = (code: number) => {
    if (exitCode !== null) return;
    exitCode = code;
    resolveExited(code);
  };

  if (response.delayMs && response.delayMs > 0) {
    const timer = setTimeout(() => {
      if (!killed) finish(response.exitCode ?? 0);
    }, response.delayMs);
    exited.then(() => clearTimeout(timer));
  } else {
    queueMicrotask(() => {
      if (!killed) finish(response.exitCode ?? 0);
    });
  }

  return {
    pid: 12345,
    exited,
    get exitCode() {
      return exitCode;
    },
    signalCode: null,
    stdout: streamFromText(response.stdout ?? ""),
    stderr: streamFromText(response.stderr ?? ""),
    kill() {
      killed = true;
      finish(143);
    },
  } as unknown as ChildProcess;
}

function createFakeLauncher(handler: (argv: readonly string[]) => FakeCommandResponse): {
  readonly launcher: ChildProcessLauncher;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const launcher: ChildProcessLauncher = {
    launch(command) {
      const argv = [...command];
      calls.push(argv);
      const response = handler(argv);
      response.onLaunch?.(argv);
      if (response.throwError) throw response.throwError;
      return createFakeChild(response);
    },
  };
  return { launcher, calls };
}

interface FakeFsState {
  readonly executables: Set<string>;
  readonly files: Map<string, Uint8Array>;
  readonly dirs: Set<string>;
  readonly chmodCalls: Array<{ readonly path: string; readonly mode: number }>;
  readonly rmCalls: string[];
  readonly mkdtempCalls: string[];
  readonly renameCalls: Array<{ readonly from: string; readonly to: string }>;
  failMkdirForPrefix?: string;
  failMkdtempForPrefix?: string;
  failRenameWithCode?: string;
}

function createFakeFs(initialExecutables: readonly string[] = []): {
  readonly fs: ToolAcquirerFs;
  readonly state: FakeFsState;
} {
  const state: FakeFsState = {
    executables: new Set(initialExecutables),
    files: new Map(),
    dirs: new Set(),
    chmodCalls: [],
    rmCalls: [],
    mkdtempCalls: [],
    renameCalls: [],
  };
  let tempCounter = 0;

  const fs: ToolAcquirerFs = {
    exists(path) {
      return state.executables.has(path) || state.files.has(path);
    },
    isExecutable(path) {
      return state.executables.has(path);
    },
    async mkdir(path) {
      if (state.failMkdirForPrefix && path.startsWith(state.failMkdirForPrefix)) {
        const err = new Error(`EACCES: permission denied, mkdir '${path}'`) as Error & {
          code: string;
        };
        err.code = "EACCES";
        throw err;
      }
      state.dirs.add(path);
      return path;
    },
    async mkdtemp(prefix) {
      if (state.failMkdtempForPrefix && prefix.startsWith(state.failMkdtempForPrefix)) {
        const err = new Error(`EACCES: permission denied, mkdtemp '${prefix}'`) as Error & {
          code: string;
        };
        err.code = "EACCES";
        throw err;
      }
      tempCounter++;
      const created = `${prefix}${tempCounter}`;
      state.mkdtempCalls.push(created);
      state.dirs.add(created);
      return created;
    },
    async writeFile(path, data) {
      state.files.set(path, new Uint8Array(data));
    },
    async readdir(path) {
      // Find files recorded under `path`
      const sep = path.includes("\\") ? "\\" : "/";
      const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
      const entries = new Map<string, DirEntry>();
      for (const filePath of [...state.files.keys(), ...state.executables]) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slashIdx = rest.indexOf(sep);
        if (slashIdx === -1) {
          entries.set(rest, { name: rest, isFile: true, isDirectory: false });
        } else {
          const dirName = rest.slice(0, slashIdx);
          if (!entries.has(dirName)) {
            entries.set(dirName, { name: dirName, isFile: false, isDirectory: true });
          }
        }
      }
      return [...entries.values()];
    },
    async chmod(path, mode) {
      state.chmodCalls.push({ path, mode });
      if ((mode & 0o111) !== 0) {
        state.executables.add(path);
      }
    },
    async rename(oldPath, newPath) {
      state.renameCalls.push({ from: oldPath, to: newPath });
      if (state.failRenameWithCode) {
        const err = new Error(`${state.failRenameWithCode}: rename failed`) as Error & {
          code: string;
        };
        err.code = state.failRenameWithCode;
        throw err;
      }
      const data = state.files.get(oldPath);
      if (data) {
        state.files.delete(oldPath);
        state.files.set(newPath, data);
      }
      if (state.executables.has(oldPath)) {
        state.executables.delete(oldPath);
        state.executables.add(newPath);
      } else {
        state.executables.add(newPath);
      }
    },
    async rm(path) {
      state.rmCalls.push(path);
      state.executables.delete(path);
      state.files.delete(path);
      for (const key of [...state.files.keys()]) {
        if (key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
          state.files.delete(key);
        }
      }
      for (const key of [...state.executables]) {
        if (key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
          state.executables.delete(key);
        }
      }
    },
  };

  return { fs, state };
}

function makeTestManifest(archiveBytes: Uint8Array): ManagedToolsManifest {
  const sha = sha256Hex(archiveBytes);
  const bytes = archiveBytes.byteLength;
  return {
    schemaVersion: 1,
    tools: {
      fd: {
        version: "10.5.2",
        repo: "sharkdp/fd",
        tagPrefix: "v",
        minimumVersion: "10.5.1",
        assets: {
          "darwin-arm64": { asset: "fd-v10.5.2-aarch64-apple-darwin.tar.gz", bytes, sha256: sha },
          "darwin-x64": { asset: "fd-v10.5.2-x86_64-apple-darwin.tar.gz", bytes, sha256: sha },
          "linux-arm64": {
            asset: "fd-v10.5.2-aarch64-unknown-linux-musl.tar.gz",
            bytes,
            sha256: sha,
          },
          "linux-x64": {
            asset: "fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz",
            bytes,
            sha256: sha,
          },
          "win32-arm64": { asset: "fd-v10.5.2-aarch64-pc-windows-msvc.zip", bytes, sha256: sha },
          "win32-x64": { asset: "fd-v10.5.2-x86_64-pc-windows-msvc.zip", bytes, sha256: sha },
        },
      },
      rg: {
        version: "16.0.0",
        repo: "BurntSushi/ripgrep",
        tagPrefix: "",
        minimumVersion: "13.0.0",
        assets: {
          "darwin-arm64": {
            asset: "ripgrep-16.0.0-aarch64-apple-darwin.tar.gz",
            bytes,
            sha256: sha,
          },
          "darwin-x64": { asset: "ripgrep-16.0.0-x86_64-apple-darwin.tar.gz", bytes, sha256: sha },
          "linux-arm64": {
            asset: "ripgrep-16.0.0-aarch64-unknown-linux-musl.tar.gz",
            bytes,
            sha256: sha,
          },
          "linux-x64": {
            asset: "ripgrep-16.0.0-x86_64-unknown-linux-musl.tar.gz",
            bytes,
            sha256: sha,
          },
          "win32-arm64": {
            asset: "ripgrep-16.0.0-aarch64-pc-windows-msvc.zip",
            bytes,
            sha256: sha,
          },
          "win32-x64": { asset: "ripgrep-16.0.0-x86_64-pc-windows-msvc.zip", bytes, sha256: sha },
        },
      },
    },
  };
}

describe("managed-tools pure helpers", () => {
  describe("resolveTargetKey", () => {
    it("maps all six supported platform/arch pairs", () => {
      expect(resolveTargetKey("darwin", "arm64")).toBe("darwin-arm64");
      expect(resolveTargetKey("darwin", "x64")).toBe("darwin-x64");
      expect(resolveTargetKey("linux", "arm64")).toBe("linux-arm64");
      expect(resolveTargetKey("linux", "x64")).toBe("linux-x64");
      expect(resolveTargetKey("win32", "arm64")).toBe("win32-arm64");
      expect(resolveTargetKey("win32", "x64")).toBe("win32-x64");
    });

    it("returns undefined for unsupported platforms and architectures", () => {
      expect(resolveTargetKey("linux", "arm")).toBeUndefined();
      expect(resolveTargetKey("android", "arm64")).toBeUndefined();
      expect(resolveTargetKey("freebsd", "x64")).toBeUndefined();
      expect(resolveTargetKey("win32", "ia32")).toBeUndefined();
    });
  });

  describe("isOfflineEnv", () => {
    it("treats 1, true, and yes (case-insensitive, trimmed) as offline", () => {
      for (const value of ["1", "true", "TRUE", "True", "yes", "YES", " yes ", " 1 "]) {
        expect(isOfflineEnv({ CODING_AGENT_OFFLINE: value }, "linux")).toBe(true);
      }
    });

    it("treats 0, false, no, blank, and other values as online", () => {
      for (const value of [undefined, "", "   ", "0", "false", "no", "off", "2", "truthy"]) {
        expect(isOfflineEnv({ CODING_AGENT_OFFLINE: value }, "linux")).toBe(false);
      }
    });

    it("matches CODING_AGENT_OFFLINE case-insensitively on Windows", () => {
      expect(isOfflineEnv({ coding_agent_offline: "true" }, "win32")).toBe(true);
      expect(isOfflineEnv({ coding_agent_offline: "true" }, "linux")).toBe(false);
    });
  });

  describe("parseToolVersion and compareSemver", () => {
    it("parses rg and fd --version output", () => {
      expect(parseToolVersion("rg", "ripgrep 16.0.0\n-SIMD -AVX\n")).toBe("16.0.0");
      expect(parseToolVersion("rg", "ripgrep 13.0.0 (rev abc123)\r\n")).toBe("13.0.0");
      expect(parseToolVersion("fd", "fd 10.5.2\n")).toBe("10.5.2");
      expect(parseToolVersion("fd", "fdfind 10.5.1\n")).toBe("10.5.1");
    });

    it("rejects malformed or mismatched tool version output", () => {
      expect(parseToolVersion("rg", "fd 10.5.2\n")).toBeUndefined();
      expect(parseToolVersion("fd", "ripgrep 16.0.0\n")).toBeUndefined();
      expect(parseToolVersion("rg", "ripgrep next")).toBeUndefined();
      expect(parseToolVersion("fd", "")).toBeUndefined();
    });

    it("compares semantic versions numerically", () => {
      expect(compareSemver("10.5.1", "10.5.2")).toBeLessThan(0);
      expect(compareSemver("10.5.2", "10.5.2")).toBe(0);
      expect(compareSemver("10.10.0", "10.5.2")).toBeGreaterThan(0);
      expect(compareSemver("13.0.0", "12.9.9")).toBeGreaterThan(0);
      expect(compareSemver("16.0.0", "13.0.0")).toBeGreaterThan(0);
    });
  });

  describe("formatAcquireFailureMessage", () => {
    it("formats messages with version, floor, deduped cause chain up to depth 5, no stacks, and remedy", () => {
      const root = new Error("connection reset\n    at socket.ts:10:5");
      const mid1 = new Error("fetch failed", { cause: root });
      const mid2 = new Error("fetch failed", { cause: mid1 });
      const top = new Error("Error: download timed out", { cause: mid2 });

      const message = formatAcquireFailureMessage("rg", "16.0.0", "13.0.0", "download-failed", top);
      expect(message).toBe(
        "rg 16.0.0 is not available: download timed out: fetch failed: connection reset (requires rg >= 13.0.0). install on PATH or retry.",
      );
      expect(message).not.toContain("at socket.ts");
    });

    it("caps cause chain depth at 5 and handles cycles", () => {
      const e6 = new Error("cause-6");
      const e5 = new Error("cause-5", { cause: e6 });
      const e4 = new Error("cause-4", { cause: e5 });
      const e3 = new Error("cause-3", { cause: e4 });
      const e2 = new Error("cause-2", { cause: e3 });
      const e1 = new Error("cause-1", { cause: e2 });

      const msg = formatAcquireFailureMessage("fd", "10.5.2", "10.5.1", "install-failed", e1);
      expect(msg).toContain("cause-1: cause-2: cause-3: cause-4: cause-5");
      expect(msg).not.toContain("cause-6");
      expect(msg).toContain("10.5.1");
      expect(msg).toContain("install on PATH or retry.");
    });

    it("uses the specified remedy for offline and unsupported-platform", () => {
      const offlineMsg = formatAcquireFailureMessage(
        "fd",
        "10.5.2",
        "10.5.1",
        "offline",
        "CODING_AGENT_OFFLINE is set",
      );
      expect(offlineMsg).toBe(
        "fd 10.5.2 is not available: CODING_AGENT_OFFLINE is set (requires fd >= 10.5.1). install on PATH or unset CODING_AGENT_OFFLINE.",
      );

      const unsupportedMsg = formatAcquireFailureMessage(
        "rg",
        "16.0.0",
        "13.0.0",
        "unsupported-platform",
        "unsupported platform linux/arm",
      );
      expect(unsupportedMsg).toBe(
        "rg 16.0.0 is not available: unsupported platform linux/arm (requires rg >= 13.0.0). install with the system package manager.",
      );
    });
  });

  describe("resolveConfiguredCacheRoot", () => {
    it("resolves OS default cache roots for Linux, macOS, and Windows", () => {
      expect(
        resolveConfiguredCacheRoot({
          platform: "linux",
          env: { XDG_CACHE_HOME: "/var/cache/user" },
          cwd: "/work",
          homeDir: "/home/dev",
        }),
      ).toEqual({ path: "/var/cache/user/coding-agent", explicit: false });

      expect(
        resolveConfiguredCacheRoot({
          platform: "linux",
          env: {},
          cwd: "/work",
          homeDir: "/home/dev",
        }),
      ).toEqual({ path: "/home/dev/.cache/coding-agent", explicit: false });

      expect(
        resolveConfiguredCacheRoot({
          platform: "darwin",
          env: {},
          cwd: "/work",
          homeDir: "/Users/dev",
        }),
      ).toEqual({ path: "/Users/dev/Library/Caches/coding-agent", explicit: false });

      expect(
        resolveConfiguredCacheRoot({
          platform: "win32",
          env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
          cwd: "C:\\work",
          homeDir: "C:\\Users\\dev",
        }),
      ).toEqual({ path: "C:\\Users\\dev\\AppData\\Local\\coding-agent", explicit: false });
    });

    it("resolves CODING_AGENT_CACHE_DIR override and treats blank as unset", () => {
      expect(
        resolveConfiguredCacheRoot({
          platform: "linux",
          env: { CODING_AGENT_CACHE_DIR: "rel/cache" },
          cwd: "/work/repo",
          homeDir: "/home/dev",
        }),
      ).toEqual({ path: "/work/repo/rel/cache", explicit: true });

      expect(
        resolveConfiguredCacheRoot({
          platform: "linux",
          env: { CODING_AGENT_CACHE_DIR: "   " },
          cwd: "/work/repo",
          homeDir: "/home/dev",
        }),
      ).toEqual({ path: "/home/dev/.cache/coding-agent", explicit: false });
    });
  });
});

describe("createToolAcquirer", () => {
  const fakeArchive = new TextEncoder().encode("fake-archive-content");
  const testManifest = makeTestManifest(fakeArchive);
  const instantSleep = async () => undefined;

  describe("lookup order, versions, and memoization", () => {
    it("returns a valid cached binary without probing PATH or fetching", async () => {
      const cachedRg = "/cache/bin/rg/16.0.0/rg";
      const { fs } = createFakeFs([cachedRg, "/usr/bin/rg"]);
      const { launcher, calls } = createFakeLauncher((argv) => {
        if (argv[0] === cachedRg && argv[1] === "--version") {
          return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
        }
        return { exitCode: 1 };
      });
      let fetchCalls = 0;
      const acquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => {
          fetchCalls++;
          return new Response(fakeArchive);
        },
        sleep: instantSleep,
      });

      const first = await acquirer.acquire("rg");
      expect(first).toEqual({ ok: true, path: cachedRg, version: "16.0.0" });
      expect(fetchCalls).toBe(0);
      expect(calls).toEqual([[cachedRg, "--version"]]);

      // Second call is memoized and does not re-probe.
      const second = await acquirer.acquire("rg");
      expect(second).toEqual(first);
      expect(calls).toHaveLength(1);
    });

    it("deletes a corrupt or mismatched cached binary and falls through to PATH", async () => {
      const cachedFd = "/cache/bin/fd/10.5.2/fd";
      const pathFd = "/usr/local/bin/fdfind";
      const { fs, state } = createFakeFs([cachedFd, pathFd]);
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === cachedFd) return { exitCode: 0, stdout: "fd 9.0.0\n" };
        if (argv[0] === pathFd) return { exitCode: 0, stdout: "fdfind 10.5.2\n" };
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/local/bin", CODING_AGENT_OFFLINE: "1" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("fd");
      expect(result).toEqual({ ok: true, path: pathFd, version: "10.5.2" });
      expect(state.rmCalls).toContain(cachedFd);
    });

    it("searches fd before fdfind on PATH", async () => {
      const { fs } = createFakeFs(["/usr/bin/fd", "/usr/bin/fdfind"]);
      const { launcher, calls } = createFakeLauncher((argv) => {
        if (argv[0] === "/usr/bin/fd") return { exitCode: 0, stdout: "fd 10.5.2\n" };
        if (argv[0] === "/usr/bin/fdfind") return { exitCode: 0, stdout: "fd 10.5.2\n" };
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/bin", CODING_AGENT_OFFLINE: "1" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("fd");
      expect(result).toEqual({ ok: true, path: "/usr/bin/fd", version: "10.5.2" });
      expect(calls).toEqual([["/usr/bin/fd", "--version"]]);
    });

    it("downloads pinned version when online even if PATH has another >= floor version, and falls back to PATH with a warning when offline or download fails", async () => {
      const pathRg = "/usr/bin/rg";
      const { fs, state } = createFakeFs([pathRg]);
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === pathRg) return { exitCode: 0, stdout: "ripgrep 14.1.0\n" };
        if (argv[0] === "tar") {
          const extractDir = argv[4] ?? "";
          state.files.set(`${extractDir}/ripgrep-16.0.0/rg`, new Uint8Array([1, 2, 3]));
          return { exitCode: 0 };
        }
        if (argv[0]?.endsWith("/rg") && argv[1] === "--version") {
          return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
        }
        return { exitCode: 1 };
      });

      // Online: downloads pinned 16.0.0
      const onlineAcquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });
      const onlineResult = await onlineAcquirer.acquire("rg");
      expect(onlineResult.ok).toBe(true);
      if (onlineResult.ok) {
        expect(onlineResult.path).toBe("/cache/bin/rg/16.0.0/rg");
        expect(onlineResult.version).toBe("16.0.0");
        expect(onlineResult.status?.level).toBe("info");
      }

      // Offline: accepts >= floor PATH version with warning
      const offlineAcquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/bin", CODING_AGENT_OFFLINE: "true" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/other-cache",
        manifest: testManifest,
        fs: createFakeFs([pathRg]).fs,
        sleep: instantSleep,
      });
      const offlineResult = await offlineAcquirer.acquire("rg");
      expect(offlineResult.ok).toBe(true);
      if (offlineResult.ok) {
        expect(offlineResult.path).toBe(pathRg);
        expect(offlineResult.version).toBe("14.1.0");
        expect(offlineResult.status?.level).toBe("warning");
      }

      // Online download fails: falls back to >= floor PATH version with warning
      const failingAcquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/other-cache",
        manifest: testManifest,
        fs: createFakeFs([pathRg]).fs,
        fetchImpl: async () => new Response("nope", { status: 404 }),
        sleep: instantSleep,
      });
      const fallbackResult = await failingAcquirer.acquire("rg");
      expect(fallbackResult.ok).toBe(true);
      if (fallbackResult.ok) {
        expect(fallbackResult.path).toBe(pathRg);
        expect(fallbackResult.version).toBe("14.1.0");
        expect(fallbackResult.status?.level).toBe("warning");
      }
    });

    it("rejects below-floor PATH binaries and reads CODING_AGENT_OFFLINE at acquire time", async () => {
      const env: Record<string, string | undefined> = {
        PATH: "/usr/bin",
        CODING_AGENT_OFFLINE: "1",
      };
      const { fs, state } = createFakeFs(["/usr/bin/fd"]);
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "/usr/bin/fd") return { exitCode: 0, stdout: "fd 10.5.0\n" };
        if (argv[0] === "tar") {
          const extractDir = argv[4] ?? "";
          state.files.set(`${extractDir}/fd`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        if (argv[0] === "/cache/bin/fd/10.5.2/fd") return { exitCode: 0, stdout: "fd 10.5.2\n" };
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env,
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      // First call while offline: fails softly and does NOT memoize.
      const first = await acquirer.acquire("fd");
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.reason).toBe("offline");
        expect(first.message).toContain("10.5.1");
        expect(first.message).toContain("install on PATH or unset CODING_AGENT_OFFLINE");
      }

      // Toggle offline off at runtime: next call retries and succeeds!
      env.CODING_AGENT_OFFLINE = "0";
      const second = await acquirer.acquire("fd");
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.path).toBe("/cache/bin/fd/10.5.2/fd");
      }
    });

    it("deduplicates concurrent in-flight acquire calls", async () => {
      const { fs, state } = createFakeFs();
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
      });
      let fetchCalls = 0;
      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => {
          fetchCalls++;
          await Bun.sleep(10);
          return new Response(fakeArchive);
        },
        sleep: instantSleep,
      });

      const [a, b] = await Promise.all([acquirer.acquire("rg"), acquirer.acquire("rg")]);
      expect(fetchCalls).toBe(1);
      expect(a).toEqual(b);
      expect(a.ok).toBe(true);
    });
  });

  describe("cache fallback and explicit override failure", () => {
    it("falls back to mkdtemp under tmpDir when the default cache root is unusable", async () => {
      const { fs, state } = createFakeFs();
      state.failMkdirForPrefix = "/home/dev/.cache/coding-agent";
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        homeDir: "/home/dev",
        tmpDir: "/tmp",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/tmp/coding-agent-cache-1/bin/rg/16.0.0/rg");
      }
    });

    it("fails without falling back when an explicit cacheDir override is unusable", async () => {
      const { fs, state } = createFakeFs();
      state.failMkdirForPrefix = "/readonly/cache";
      const { launcher } = createFakeLauncher(() => ({ exitCode: 0 }));

      const acquirer = createToolAcquirer({
        launcher,
        env: { CODING_AGENT_CACHE_DIR: "/readonly/cache" },
        platform: "linux",
        arch: "x64",
        tmpDir: "/tmp",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("install-failed");
        expect(result.message).toContain("/readonly/cache");
      }
      expect(state.mkdtempCalls).toHaveLength(0);
    });
  });

  describe("download retries and integrity checks", () => {
    it("retries retryable HTTP statuses and network errors with 250/500ms backoff", async () => {
      const { fs, state } = createFakeFs();
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
      });

      const sleepCalls: number[] = [];
      let attempt = 0;
      const fetchImpl: FetchFn = async () => {
        attempt++;
        if (attempt === 1) throw new Error("ECONNRESET");
        if (attempt === 2) return new Response("rate limited", { status: 429 });
        return new Response(fakeArchive);
      };

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(true);
      expect(attempt).toBe(3);
      expect(sleepCalls).toEqual([250, 500]);
    });

    it("does not retry non-retryable 404 responses", async () => {
      const { fs } = createFakeFs();
      const { launcher } = createFakeLauncher(() => ({ exitCode: 1 }));
      let attempts = 0;

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => {
          attempts++;
          return new Response("not found", { status: 404 });
        },
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("download-failed");
        expect(result.message).toContain("HTTP 404");
      }
      expect(attempts).toBe(1);
    });

    it("retries size mismatch and SHA-256 mismatch up to 3 attempts then returns integrity-failed", async () => {
      const { fs } = createFakeFs();
      const { launcher } = createFakeLauncher(() => ({ exitCode: 1 }));

      let sizeAttempts = 0;
      const sizeAcquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => {
          sizeAttempts++;
          return new Response(new Uint8Array(fakeArchive.byteLength + 5));
        },
        sleep: instantSleep,
      });

      const sizeResult = await sizeAcquirer.acquire("fd");
      expect(sizeAttempts).toBe(3);
      expect(sizeResult.ok).toBe(false);
      if (!sizeResult.ok) {
        expect(sizeResult.reason).toBe("integrity-failed");
        expect(sizeResult.message).toContain("10.5.1");
        expect(sizeResult.message).toContain("install on PATH or retry");
      }

      let hashAttempts = 0;
      const tampered = new Uint8Array(fakeArchive);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      const hashAcquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => {
          hashAttempts++;
          return new Response(tampered);
        },
        sleep: instantSleep,
      });

      const hashResult = await hashAcquirer.acquire("rg");
      expect(hashAttempts).toBe(3);
      expect(hashResult.ok).toBe(false);
      if (!hashResult.ok) {
        expect(hashResult.reason).toBe("integrity-failed");
        expect(hashResult.message).toContain("SHA-256 mismatch");
      }
    });
  });

  describe("extraction command selection, install, cleanup, and abort", () => {
    it("uses tar -xzf and chmod 0755 on Unix and cleans up the temp dir", async () => {
      const { fs, state } = createFakeFs();
      const { launcher, calls } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/nested/fd`, new Uint8Array([1, 2]));
          return { exitCode: 0 };
        }
        if (argv[1] === "--version") return { exitCode: 0, stdout: "fd 10.5.2\n" };
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("fd");
      expect(result.ok).toBe(true);
      expect(calls[0]?.[0]).toBe("tar");
      expect(calls[0]?.[1]).toBe("-xzf");
      expect(state.chmodCalls.some((c) => c.mode === 0o755)).toBe(true);
      expect(state.rmCalls).toContain("/cache/tmp/fd-1");
    });

    it("uses System32 tar.exe then PowerShell Expand-Archive on Windows, never unzip, and skips chmod", async () => {
      const { fs, state } = createFakeFs();
      const { launcher, calls } = createFakeLauncher((argv) => {
        if (argv[0]?.endsWith("tar.exe")) {
          return { exitCode: 1, stderr: "tar.exe failed" };
        }
        if (argv[0] === "powershell.exe") {
          const cmd = argv[4] ?? "";
          const match = /-DestinationPath '([^']+)'/.exec(cmd);
          const extractDir = match?.[1] ?? "";
          state.files.set(`${extractDir}\\fd.exe`, new Uint8Array([1, 2]));
          return { exitCode: 0 };
        }
        if (argv[1] === "--version") return { exitCode: 0, stdout: "fd 10.5.2\n" };
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
        arch: "x64",
        cacheDir: "C:\\cache",
        cwd: "C:\\work",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("fd");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("C:\\cache\\bin\\fd\\10.5.2\\fd.exe");
      }
      expect(calls[0]?.[0]).toBe("C:\\Windows\\System32\\tar.exe");
      expect(calls[0]?.[1]).toBe("-xf");
      expect(calls[1]?.[0]).toBe("powershell.exe");
      expect(calls[1]?.[4]).toContain("Expand-Archive");
      expect(calls.some((argv) => argv[0] === "unzip")).toBe(false);
      expect(state.chmodCalls).toHaveLength(0);
      expect(state.rmCalls).toContain("C:\\cache\\tmp\\fd-1");
    });

    it("cleans up temp dir and removes bad binary when post-install probe fails", async () => {
      const { fs, state } = createFakeFs();
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 15.0.0\n" }; // wrong version
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("install-failed");
      }
      expect(state.rmCalls).toContain("/cache/bin/rg/16.0.0/rg");
      expect(state.rmCalls).toContain("/cache/tmp/rg-1");
    });

    it("aborts download or extraction on AbortSignal and cleans up temp dir", async () => {
      const { fs, state } = createFakeFs();
      const controller = new AbortController();
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          setTimeout(() => controller.abort(), 10);
          return { exitCode: 0, delayMs: 2_000 };
        }
        return { exitCode: 0 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg", { signal: controller.signal });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("cancelled");
      }
      expect(state.rmCalls).toContain("/cache/tmp/rg-1");
    });

    it("returns unsupported-platform with package manager remedy when no PATH fallback exists", async () => {
      const { fs } = createFakeFs();
      const { launcher } = createFakeLauncher(() => ({ exitCode: 1 }));

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "freebsd",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unsupported-platform");
        expect(result.message).toContain("13.0.0");
        expect(result.message).toContain("install with the system package manager");
      }
    });

    it("deletes a non-executable corrupt cache entry and continues to PATH", async () => {
      const cachedRg = "/cache/bin/rg/16.0.0/rg";
      const pathRg = "/usr/bin/rg";
      const { fs, state } = createFakeFs([pathRg]);
      state.files.set(cachedRg, new Uint8Array([0, 1, 2])); // exists but not executable

      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === pathRg) return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: { PATH: "/usr/bin", CODING_AGENT_OFFLINE: "1" },
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result).toEqual({ ok: true, path: pathRg, version: "16.0.0" });
      expect(state.rmCalls).toContain(cachedRg);
    });

    it("falls back to tmpDir when default cache tmp exists but mkdtemp fails", async () => {
      const { fs, state } = createFakeFs();
      state.failMkdtempForPrefix = "/home/dev/.cache/coding-agent/tmp";
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        homeDir: "/home/dev",
        tmpDir: "/tmp",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/tmp/coding-agent-cache-1/bin/rg/16.0.0/rg");
      }
    });

    it("retries HTTP 408, 425, and 503 responses and respects overall timeout budget", async () => {
      const { fs, state } = createFakeFs();
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
      });

      const statuses = [408, 425, 503];
      let attempt = 0;
      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => {
          const status = statuses[attempt++] ?? 500;
          return new Response("transient", { status });
        },
        sleep: instantSleep,
      });

      const res = await acquirer.acquire("rg");
      expect(res.ok).toBe(false);
      expect(attempt).toBe(3);

      // Per-attempt timeout aborts slow fetch
      let timedOutAttempts = 0;
      const timeoutAcquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        overallTimeoutMs: 40,
        attemptTimeoutMs: 15,
        retryBackoffMs: [5, 5],
        fetchImpl: async (_url, init) => {
          timedOutAttempts++;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          });
        },
      });

      const timeoutRes = await timeoutAcquirer.acquire("rg");
      expect(timeoutRes.ok).toBe(false);
      if (!timeoutRes.ok) {
        expect(timeoutRes.reason).toBe("download-failed");
        expect(timeoutRes.message).toContain("timed out");
      }
      expect(timedOutAttempts).toBeGreaterThanOrEqual(1);
    });

    it("aborts download mid-flight on AbortSignal without retrying", async () => {
      const { fs } = createFakeFs();
      const { launcher } = createFakeLauncher(() => ({ exitCode: 0 }));
      const controller = new AbortController();
      let attempts = 0;

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async (_url, init) => {
          attempts++;
          setTimeout(() => controller.abort(), 10);
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          });
        },
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg", { signal: controller.signal });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("cancelled");
      }
      expect(attempts).toBe(1);
    });

    it("recovers idempotently when concurrent rename fails with EEXIST and destination binary is valid", async () => {
      const { fs, state } = createFakeFs();
      state.failRenameWithCode = "EEXIST";
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        if (argv[0] === "/cache/bin/rg/16.0.0/rg" && argv[1] === "--version") {
          return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
        }
        return { exitCode: 1 };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const result = await acquirer.acquire("rg");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/cache/bin/rg/16.0.0/rg");
      }
      expect(state.rmCalls).toContain("/cache/tmp/rg-1");
    });

    it("retries on a later call after an extraction failure", async () => {
      const { fs, state } = createFakeFs();
      let tarCalls = 0;
      const { launcher } = createFakeLauncher((argv) => {
        if (argv[0] === "tar") {
          tarCalls++;
          if (tarCalls === 1) return { exitCode: 1, stderr: "corrupt stream" };
          state.files.set(`${argv[4]}/rg`, new Uint8Array([1]));
          return { exitCode: 0 };
        }
        return { exitCode: 0, stdout: "ripgrep 16.0.0\n" };
      });

      const acquirer = createToolAcquirer({
        launcher,
        env: {},
        platform: "linux",
        arch: "x64",
        cacheDir: "/cache",
        manifest: testManifest,
        fs,
        fetchImpl: async () => new Response(fakeArchive),
        sleep: instantSleep,
      });

      const first = await acquirer.acquire("rg");
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.reason).toBe("install-failed");

      const second = await acquirer.acquire("rg");
      expect(second.ok).toBe(true);
      expect(tarCalls).toBe(2);
    });
  });
});
