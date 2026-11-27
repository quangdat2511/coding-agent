import { accessSync, constants, existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { environmentKeyOf } from "./child-environment.ts";
import type { ChildProcessLauncher } from "./child-process.ts";
import { errnoOf } from "./errno.ts";
import defaultManifestJson from "./managed-tools.json";
import { ArchiveIntegrityError, readVerifiedArchive } from "./managed-tools-archive.ts";
import { normalizeWindowsShellPath } from "./paths.ts";
import { type ProcessKillFn, runSupervised } from "./process-run.ts";

export type ManagedToolName = "rg" | "fd";

export type PlatformArchKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

export interface ManagedToolAsset {
  readonly asset: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManagedToolEntry {
  readonly version: string;
  readonly repo: string;
  readonly tagPrefix: string;
  readonly minimumVersion: string;
  readonly assets: Readonly<Record<PlatformArchKey, ManagedToolAsset>>;
}

export interface ManagedToolsManifest {
  readonly schemaVersion: number;
  readonly tools: Readonly<Record<ManagedToolName, ManagedToolEntry>>;
}

export type AcquireFailureReason =
  | "offline"
  | "unsupported-platform"
  | "not-found"
  | "download-failed"
  | "integrity-failed"
  | "install-failed"
  | "cancelled";

export interface AcquireStatus {
  readonly level: "info" | "warning";
  readonly message: string;
}

export type AcquireResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly version: string;
      /**
       * Optional user-facing notice for interactive prefetch (e.g. `info` after installing a
       * downloaded binary, or `warning` when falling back to a floor-satisfying PATH binary).
       * Intentionally omitted for silent cache hits and exact pinned PATH hits.
       */
      readonly status?: AcquireStatus;
    }
  | {
      readonly ok: false;
      readonly reason: AcquireFailureReason;
      readonly message: string;
    };

export interface AcquireOptions {
  readonly signal?: AbortSignal;
}

export interface ToolAcquirer {
  acquire(name: ManagedToolName, options?: AcquireOptions): Promise<AcquireResult>;
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface ToolAcquirerFs {
  exists(path: string): boolean;
  isExecutable(path: string): boolean;
  mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<readonly DirEntry[]>;
  chmod(path: string, mode: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface CreateToolAcquirerOptions {
  readonly launcher: ChildProcessLauncher;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly cacheDir?: string;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly tmpDir?: string;
  readonly manifest?: ManagedToolsManifest;
  readonly downloadBaseUrl?: string;
  readonly fetchImpl?: FetchFn;
  readonly fs?: ToolAcquirerFs;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly overallTimeoutMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly retryBackoffMs?: readonly number[];
  readonly probeTimeoutMs?: number;
  readonly extractTimeoutMs?: number;
  readonly killProcess?: ProcessKillFn;
}

const DEFAULT_MANIFEST: ManagedToolsManifest = defaultManifestJson;

const SUPPORTED_TARGETS: ReadonlySet<string> = new Set<PlatformArchKey>([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [250, 500];
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;
const MAX_CAUSE_DEPTH = 5;

const OFFLINE_VALUES = new Set(["1", "true", "yes"]);

const VERSION_LINE_PATTERN: Record<ManagedToolName, RegExp> = {
  fd: /^(?:fd|fdfind)\s+(\d+\.\d+\.\d+)(?:\s|$)/,
  rg: /^ripgrep\s+(\d+\.\d+\.\d+)(?:\s|$)/,
};

const PATH_NAMES: Record<ManagedToolName, readonly string[]> = {
  fd: ["fd", "fdfind"],
  rg: ["rg"],
};

class CancelledError extends Error {
  constructor(message = "operation cancelled") {
    super(message);
  }
}

class DownloadError extends Error {
  readonly retryable: boolean;
  readonly reason: "download-failed" | "integrity-failed";

  constructor(
    message: string,
    options: {
      retryable: boolean;
      reason?: "download-failed" | "integrity-failed";
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.retryable = options.retryable;
    this.reason = options.reason ?? "download-failed";
  }
}

class InstallError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export function resolveTargetKey(
  platform: NodeJS.Platform | string,
  arch: string,
): PlatformArchKey | undefined {
  const key = `${platform}-${arch}`;
  return SUPPORTED_TARGETS.has(key) ? (key as PlatformArchKey) : undefined;
}

function getEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const target = environmentKeyOf(name, platform);
  for (const [key, value] of Object.entries(env)) {
    if (environmentKeyOf(key, platform) === target) return value;
  }
  return undefined;
}

export function isOfflineEnv(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const raw = getEnvVar(env, "CODING_AGENT_OFFLINE", platform);
  if (raw === undefined) return false;
  return OFFLINE_VALUES.has(raw.trim().toLowerCase());
}

export function parseToolVersion(name: ManagedToolName, stdout: string): string | undefined {
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = VERSION_LINE_PATTERN[name].exec(firstLine);
  return match?.[1];
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface ResolvedCacheRoot {
  readonly path: string | undefined;
  readonly explicit: boolean;
}

export function resolveConfiguredCacheRoot(options: {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cacheDir?: string;
  readonly cwd: string;
  readonly homeDir?: string;
}): ResolvedCacheRoot {
  const pathImpl = options.platform === "win32" ? win32 : posix;
  const resolveAbsolute = (raw: string, ...segments: string[]): string => {
    const normalized = normalizeWindowsShellPath(raw, options.platform);
    return pathImpl.resolve(options.cwd, normalized, ...segments);
  };

  const rawOverride =
    options.cacheDir !== undefined && options.cacheDir.trim() !== ""
      ? options.cacheDir.trim()
      : getEnvVar(options.env, "CODING_AGENT_CACHE_DIR", options.platform)?.trim();

  if (rawOverride !== undefined && rawOverride !== "") {
    return {
      path: resolveAbsolute(rawOverride),
      explicit: true,
    };
  }

  if (options.platform === "win32") {
    const localAppData = getEnvVar(options.env, "LOCALAPPDATA", options.platform)?.trim();
    if (localAppData) {
      const normalized = normalizeWindowsShellPath(localAppData, "win32");
      if (win32.isAbsolute(normalized)) {
        return { path: win32.join(normalized, "coding-agent"), explicit: false };
      }
    }
    if (options.homeDir) {
      const normalizedHome = normalizeWindowsShellPath(options.homeDir, "win32");
      if (win32.isAbsolute(normalizedHome)) {
        return {
          path: win32.join(normalizedHome, "AppData", "Local", "coding-agent"),
          explicit: false,
        };
      }
    }
    return { path: undefined, explicit: false };
  }

  if (options.platform === "darwin") {
    if (options.homeDir && posix.isAbsolute(options.homeDir)) {
      return {
        path: posix.join(options.homeDir, "Library", "Caches", "coding-agent"),
        explicit: false,
      };
    }
    return { path: undefined, explicit: false };
  }

  // Per the XDG Base Directory Specification, relative XDG_CACHE_HOME values are invalid and must
  // be ignored so we never place managed binaries inside the repository working directory.
  const xdgCacheHome = getEnvVar(options.env, "XDG_CACHE_HOME", options.platform)?.trim();
  if (xdgCacheHome && posix.isAbsolute(xdgCacheHome)) {
    return { path: posix.join(xdgCacheHome, "coding-agent"), explicit: false };
  }
  if (options.homeDir && posix.isAbsolute(options.homeDir)) {
    return { path: posix.join(options.homeDir, ".cache", "coding-agent"), explicit: false };
  }
  return { path: undefined, explicit: false };
}

function cleanErrorLine(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.replace(/^Error:\s*/i, "").trim();
}

export function formatCauseChain(error: unknown, maxDepth = MAX_CAUSE_DEPTH): string {
  const parts: string[] = [];
  const seenMessages = new Set<string>();
  const seenObjects = new Set<object>();
  let current: unknown = error;
  let depth = 0;

  while (current !== undefined && current !== null && depth < maxDepth) {
    if (typeof current === "object") {
      if (seenObjects.has(current)) break;
      seenObjects.add(current);
    }

    let text: string;
    let next: unknown;
    if (current instanceof Error) {
      text = cleanErrorLine(current.message);
      next = current.cause;
    } else if (typeof current === "string") {
      text = cleanErrorLine(current);
      next = undefined;
    } else {
      text = cleanErrorLine(String(current));
      next = undefined;
    }

    if (text !== "" && !seenMessages.has(text)) {
      seenMessages.add(text);
      parts.push(text);
    }

    current = next;
    depth++;
  }

  return parts.length > 0 ? parts.join(": ") : "unknown error";
}

function remedyFor(reason: AcquireFailureReason): string {
  switch (reason) {
    case "offline":
      return "install on PATH or unset CODING_AGENT_OFFLINE";
    case "unsupported-platform":
      return "install with the system package manager";
    case "cancelled":
      return "retry";
    case "not-found":
    case "download-failed":
    case "integrity-failed":
    case "install-failed":
      return "install on PATH or retry";
  }
}

export function formatAcquireFailureMessage(
  name: ManagedToolName,
  version: string,
  minimumVersion: string,
  reason: AcquireFailureReason,
  cause: unknown,
): string {
  const causeText = formatCauseChain(cause);
  const remedy = remedyFor(reason);
  return `${name} ${version} is not available: ${causeText} (requires ${name} >= ${minimumVersion}). ${remedy}.`;
}

export function createNodeToolAcquirerFs(
  platform: NodeJS.Platform = process.platform,
): ToolAcquirerFs {
  return {
    exists(path: string): boolean {
      return existsSync(path);
    },
    isExecutable(path: string): boolean {
      try {
        if (!statSync(path).isFile()) return false;
        if (platform !== "win32") accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    mkdir: (path, options) => mkdir(path, options),
    mkdtemp: (prefix) => mkdtemp(prefix),
    writeFile: (path, data) => writeFile(path, data),
    readdir: async (path) => {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
      }));
    },
    chmod: (path, mode) => chmod(path, mode),
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    rm: (path, options) => rm(path, options),
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new CancelledError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ChildCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly launchError?: unknown;
}

async function runChildCommand(
  launcher: ChildProcessLauncher,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  killProcess?: ProcessKillFn,
): Promise<ChildCommandResult> {
  if (signal?.aborted) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true };
  }

  let stdout = "";
  let stderr = "";
  try {
    const exit = await runSupervised(launcher, {
      argv,
      timeoutMs,
      signal: signal ?? new AbortController().signal,
      waitForTreeExit: true,
      killProcess,
      onOutput: (_chunk, text) => {
        stdout += text;
      },
      onStderr: (_chunk, text) => {
        stderr += text;
      },
    });
    return {
      exitCode: exit.exitCode,
      stdout,
      stderr,
      timedOut: exit.stopReason === "timeout",
      cancelled: exit.stopReason === "cancelled",
    };
  } catch (error) {
    return {
      exitCode: null,
      stdout,
      stderr,
      timedOut: false,
      cancelled: false,
      launchError: error,
    };
  }
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599);
}

function psEscape(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function findBinaryRecursive(
  fs: ToolAcquirerFs,
  pathImpl: typeof posix | typeof win32,
  dir: string,
  binaryName: string,
): Promise<string | undefined> {
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const fullPath = pathImpl.join(dir, entry.name);
    if (entry.isFile && entry.name === binaryName) {
      return fullPath;
    }
    if (entry.isDirectory) {
      const nested = await findBinaryRecursive(fs, pathImpl, fullPath, binaryName);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function createToolAcquirer(options: CreateToolAcquirerOptions): ToolAcquirer {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? safeHomedir();
  const tmpDir = options.tmpDir ?? tmpdir();
  const manifest = options.manifest ?? DEFAULT_MANIFEST;
  const downloadBaseUrl = (options.downloadBaseUrl ?? "https://github.com").replace(/\/$/, "");
  const fetchImpl: FetchFn = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const fs = options.fs ?? createNodeToolAcquirerFs(platform);
  const sleep = options.sleep ?? defaultSleep;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const extractTimeoutMs = options.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;

  const pathImpl = platform === "win32" ? win32 : posix;
  const dirMode = platform === "win32" ? undefined : 0o700;

  let fallbackCacheRoot: string | undefined;

  const resolved = new Map<ManagedToolName, Extract<AcquireResult, { ok: true }>>();
  const inFlight = new Map<ManagedToolName, Promise<AcquireResult>>();

  function binaryNameOf(name: ManagedToolName): string {
    return platform === "win32" ? `${name}.exe` : name;
  }

  function currentConfiguredCache(): ResolvedCacheRoot {
    return resolveConfiguredCacheRoot({
      platform,
      env,
      cacheDir: options.cacheDir,
      cwd,
      homeDir,
    });
  }

  function currentReadCacheRoots(): string[] {
    const configured = currentConfiguredCache();
    if (configured.explicit) {
      return configured.path !== undefined ? [configured.path] : [];
    }
    const roots: string[] = [];
    if (configured.path !== undefined) roots.push(configured.path);
    if (fallbackCacheRoot !== undefined && fallbackCacheRoot !== configured.path) {
      roots.push(fallbackCacheRoot);
    }
    return roots;
  }

  async function prepareRootForInstall(
    root: string,
    name: ManagedToolName,
    version: string,
  ): Promise<{ readonly tempDir: string; readonly versionDir: string }> {
    const tmpParent = pathImpl.join(root, "tmp");
    await fs.mkdir(tmpParent, { recursive: true, mode: dirMode });
    const tempDir = await fs.mkdtemp(pathImpl.join(tmpParent, `${name}-`));
    const versionDir = pathImpl.join(root, "bin", name, version);
    try {
      await fs.mkdir(versionDir, { recursive: true, mode: dirMode });
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { tempDir, versionDir };
  }

  async function createFallbackInstallDirs(
    name: ManagedToolName,
    version: string,
  ): Promise<{ readonly tempDir: string; readonly versionDir: string }> {
    try {
      const created = await fs.mkdtemp(pathImpl.join(tmpDir, "coding-agent-cache-"));
      if (platform !== "win32") {
        await fs.chmod(created, 0o700).catch(() => undefined);
      }
      const prepared = await prepareRootForInstall(created, name, version);
      fallbackCacheRoot = created;
      return prepared;
    } catch (error) {
      throw new InstallError("unable to create temporary fallback cache directory", error);
    }
  }

  async function prepareInstallDirs(
    name: ManagedToolName,
    version: string,
  ): Promise<{
    readonly tempDir: string;
    readonly versionDir: string;
    readonly usingDefaultCache: boolean;
  }> {
    const configured = currentConfiguredCache();
    if (configured.explicit) {
      const explicitRoot = configured.path;
      if (explicitRoot === undefined) {
        throw new InstallError("explicit cache directory could not be resolved");
      }
      try {
        const dirs = await prepareRootForInstall(explicitRoot, name, version);
        return { ...dirs, usingDefaultCache: false };
      } catch (error) {
        throw new InstallError(`cache directory ${explicitRoot} is not writable`, error);
      }
    }

    if (fallbackCacheRoot !== undefined) {
      try {
        const dirs = await prepareRootForInstall(fallbackCacheRoot, name, version);
        return { ...dirs, usingDefaultCache: false };
      } catch {
        fallbackCacheRoot = undefined;
      }
    }

    if (configured.path !== undefined) {
      try {
        const dirs = await prepareRootForInstall(configured.path, name, version);
        return { ...dirs, usingDefaultCache: true };
      } catch {
        // Default cache root (tmp or bin) is unusable; fall back to tmpdir.
      }
    }

    const dirs = await createFallbackInstallDirs(name, version);
    return { ...dirs, usingDefaultCache: false };
  }

  async function probeVersion(
    binaryPath: string,
    name: ManagedToolName,
    signal?: AbortSignal,
  ): Promise<{ readonly version?: string; readonly cancelled: boolean }> {
    const result = await runChildCommand(
      options.launcher,
      [binaryPath, "--version"],
      probeTimeoutMs,
      signal,
      options.killProcess,
    );
    if (result.cancelled) return { cancelled: true };
    if (result.launchError !== undefined || result.timedOut || result.exitCode !== 0) {
      return { cancelled: false };
    }
    return { version: parseToolVersion(name, result.stdout), cancelled: false };
  }

  function findPathCandidates(name: ManagedToolName): string[] {
    const rawPath = getEnvVar(env, "PATH", platform) ?? "";
    const dirs = rawPath.split(pathImpl.delimiter).filter((dir) => dir !== "");
    const suffixes = PATH_NAMES[name].map((base) => (platform === "win32" ? `${base}.exe` : base));
    const seen = new Set<string>();
    const results: string[] = [];

    for (const candidateName of suffixes) {
      for (const dir of dirs) {
        const normalizedDir = normalizeWindowsShellPath(dir, platform);
        const candidate = pathImpl.resolve(cwd, pathImpl.join(normalizedDir, candidateName));
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (fs.isExecutable(candidate)) {
          results.push(candidate);
        }
      }
    }

    return results;
  }

  async function downloadVerifiedArchive(
    url: string,
    asset: ManagedToolAsset,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const deadline = Date.now() + overallTimeoutMs;
    let lastError: DownloadError | undefined;
    const overallTimeoutError = () =>
      lastError ??
      new DownloadError(`overall download timeout (${overallTimeoutMs} ms) exceeded`, {
        retryable: false,
      });

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new CancelledError();

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw overallTimeoutError();
      }

      const perAttemptMs = Math.min(attemptTimeoutMs, remainingMs);
      const attemptController = new AbortController();
      let timedOut = false;

      const onCallerAbort = () => {
        attemptController.abort(new CancelledError());
      };
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      const attemptTimer = setTimeout(() => {
        timedOut = true;
        attemptController.abort(
          new DownloadError(`attempt ${attempt} timed out after ${perAttemptMs} ms`, {
            retryable: true,
          }),
        );
      }, perAttemptMs);

      try {
        const response = await fetchImpl(url, {
          signal: attemptController.signal,
          headers: { "User-Agent": "coding-agent" },
        });

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new DownloadError(`HTTP ${response.status} downloading ${url}`, {
            retryable: isRetryableStatus(response.status),
          });
        }

        try {
          return await readVerifiedArchive(response, url, asset, attemptController.signal);
        } catch (verifyErr) {
          if (verifyErr instanceof ArchiveIntegrityError) {
            throw new DownloadError(verifyErr.message, {
              retryable: true,
              reason: "integrity-failed",
            });
          }
          throw verifyErr;
        }
      } catch (error) {
        if (signal?.aborted || error instanceof CancelledError) {
          throw new CancelledError();
        }
        const downloadErr =
          error instanceof DownloadError
            ? error
            : timedOut
              ? new DownloadError(`attempt ${attempt} timed out after ${perAttemptMs} ms`, {
                  retryable: true,
                  cause: error,
                })
              : new DownloadError(`download failed for ${url}`, {
                  retryable: true,
                  cause: error,
                });

        if (!downloadErr.retryable || attempt === MAX_DOWNLOAD_ATTEMPTS) {
          throw downloadErr;
        }
        lastError = downloadErr;
      } finally {
        clearTimeout(attemptTimer);
        signal?.removeEventListener("abort", onCallerAbort);
      }

      const backoffMs =
        retryBackoffMs[attempt - 1] ?? retryBackoffMs[retryBackoffMs.length - 1] ?? 250;
      const remainingAfterAttempt = deadline - Date.now();
      if (remainingAfterAttempt <= 0) {
        throw overallTimeoutError();
      }
      await sleep(Math.min(backoffMs, remainingAfterAttempt), signal);
      if (signal?.aborted) throw new CancelledError();
    }

    throw lastError ?? new DownloadError(`download failed for ${url}`, { retryable: false });
  }

  async function extractArchive(
    archivePath: string,
    extractDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (platform !== "win32") {
      const result = await runChildCommand(
        options.launcher,
        ["tar", "-xzf", archivePath, "-C", extractDir],
        extractTimeoutMs,
        signal,
        options.killProcess,
      );
      if (result.cancelled) throw new CancelledError();
      if (result.launchError !== undefined) {
        throw new InstallError("failed to launch tar", result.launchError);
      }
      if (result.timedOut) {
        throw new InstallError(`tar extraction timed out after ${extractTimeoutMs} ms`);
      }
      if (result.exitCode !== 0) {
        throw new InstallError(
          `tar extraction failed (exit ${result.exitCode}): ${result.stderr.trim() || "unknown error"}`,
        );
      }
      return;
    }

    const systemRoot = getEnvVar(env, "SystemRoot", platform)?.trim() || "C:\\Windows";
    const tarExe = win32.join(systemRoot, "System32", "tar.exe");
    const tarResult = await runChildCommand(
      options.launcher,
      [tarExe, "-xf", archivePath, "-C", extractDir],
      extractTimeoutMs,
      signal,
      options.killProcess,
    );
    if (tarResult.cancelled) throw new CancelledError();
    if (tarResult.launchError === undefined && !tarResult.timedOut && tarResult.exitCode === 0) {
      return;
    }

    const tarFailure =
      tarResult.launchError !== undefined
        ? formatCauseChain(tarResult.launchError)
        : tarResult.timedOut
          ? "timed out"
          : `exit ${tarResult.exitCode}${tarResult.stderr.trim() ? `: ${tarResult.stderr.trim()}` : ""}`;

    const psResult = await runChildCommand(
      options.launcher,
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${psEscape(archivePath)} -DestinationPath ${psEscape(extractDir)} -Force`,
      ],
      extractTimeoutMs,
      signal,
      options.killProcess,
    );
    if (psResult.cancelled) throw new CancelledError();
    if (psResult.launchError !== undefined) {
      throw new InstallError(
        `Windows extraction failed (tar.exe: ${tarFailure}; powershell.exe failed to launch)`,
        psResult.launchError,
      );
    }
    if (psResult.timedOut) {
      throw new InstallError(
        `Windows extraction failed (tar.exe: ${tarFailure}; Expand-Archive timed out)`,
      );
    }
    if (psResult.exitCode !== 0) {
      throw new InstallError(
        `Windows extraction failed (tar.exe: ${tarFailure}; Expand-Archive exit ${psResult.exitCode}: ${psResult.stderr.trim() || "unknown error"})`,
      );
    }
  }

  async function installIntoPreparedDirs(
    name: ManagedToolName,
    tool: ManagedToolEntry,
    asset: ManagedToolAsset,
    archiveBytes: Uint8Array,
    dirs: { readonly tempDir: string; readonly versionDir: string },
    allowRenameFallback: boolean,
    signal?: AbortSignal,
  ): Promise<string | "fallback-needed"> {
    const { tempDir, versionDir } = dirs;
    try {
      if (signal?.aborted) throw new CancelledError();

      const archivePath = pathImpl.join(tempDir, asset.asset);
      const extractDir = pathImpl.join(tempDir, "extracted");
      await fs.mkdir(extractDir, { recursive: true, mode: dirMode });
      await fs.writeFile(archivePath, archiveBytes);

      await extractArchive(archivePath, extractDir, signal);

      if (signal?.aborted) throw new CancelledError();

      const binaryName = binaryNameOf(name);
      const extractedBinary = await findBinaryRecursive(fs, pathImpl, extractDir, binaryName);
      if (extractedBinary === undefined) {
        throw new InstallError(`expected binary ${binaryName} not found inside ${asset.asset}`);
      }

      if (platform !== "win32") {
        await fs.chmod(extractedBinary, 0o755);
      }

      const destPath = pathImpl.join(versionDir, binaryName);

      try {
        await fs.rename(extractedBinary, destPath);
      } catch (renameErr) {
        const code = errnoOf(renameErr);
        // Another concurrent installer may have already moved the binary into place (especially on Windows).
        if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
          const existingProbe = await probeVersion(destPath, name, signal);
          if (existingProbe.cancelled) throw new CancelledError();
          if (existingProbe.version === tool.version) {
            return destPath;
          }
        }
        // If an existing versionDir in the default cache is read-only, mkdir succeeded earlier
        // and only rename fails; fall back to a temporary cache directory under tmpDir.
        if (allowRenameFallback && (code === "EACCES" || code === "EPERM" || code === "EROFS")) {
          return "fallback-needed";
        }
        throw new InstallError(`failed to move ${binaryName} into ${destPath}`, renameErr);
      }

      const probed = await probeVersion(destPath, name, signal);
      if (probed.cancelled) {
        // Do not delete destPath on cancellation: another acquirer sharing this cache may already
        // have resolved and be using it. Only this attempt's tempDir is cleaned up in finally.
        throw new CancelledError();
      }
      if (probed.version !== tool.version) {
        await fs.rm(destPath, { force: true }).catch(() => undefined);
        throw new InstallError(
          `installed ${name} reported version ${probed.version ?? "unknown"}, expected ${tool.version}`,
        );
      }

      return destPath;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function installArchive(
    name: ManagedToolName,
    tool: ManagedToolEntry,
    asset: ManagedToolAsset,
    archiveBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new CancelledError();

    const prepared = await prepareInstallDirs(name, tool.version);
    const first = await installIntoPreparedDirs(
      name,
      tool,
      asset,
      archiveBytes,
      prepared,
      prepared.usingDefaultCache,
      signal,
    );
    if (first !== "fallback-needed") return first;

    const fallbackDirs = await createFallbackInstallDirs(name, tool.version);
    const second = await installIntoPreparedDirs(
      name,
      tool,
      asset,
      archiveBytes,
      fallbackDirs,
      false,
      signal,
    );
    if (second === "fallback-needed") {
      throw new InstallError(`failed to move ${binaryNameOf(name)} into fallback cache`);
    }
    return second;
  }

  async function acquireUncached(
    name: ManagedToolName,
    signal?: AbortSignal,
  ): Promise<AcquireResult> {
    const tool = manifest.tools[name];

    const fail = (reason: AcquireFailureReason, cause: unknown): AcquireResult => ({
      ok: false,
      reason,
      message: formatAcquireFailureMessage(name, tool.version, tool.minimumVersion, reason, cause),
    });

    try {
      if (signal?.aborted) {
        return fail("cancelled", "operation cancelled");
      }

      // 1. Versioned cache lookup (check configured default root and any temp fallback root)
      for (const readCacheRoot of currentReadCacheRoots()) {
        const cachedPath = pathImpl.join(
          readCacheRoot,
          "bin",
          name,
          tool.version,
          binaryNameOf(name),
        );
        if (fs.isExecutable(cachedPath)) {
          const probe = await probeVersion(cachedPath, name, signal);
          if (probe.cancelled) return fail("cancelled", "operation cancelled");
          if (probe.version === tool.version) {
            return { ok: true, path: cachedPath, version: tool.version };
          }
          // Corrupt or mismatched cache entry: delete and continue.
          await fs.rm(cachedPath, { force: true }).catch(() => undefined);
        } else if (fs.exists(cachedPath)) {
          // Non-executable corrupt/partial cache entry: delete and continue.
          await fs.rm(cachedPath, { force: true }).catch(() => undefined);
        }
      }

      // 2. PATH lookup (fd then fdfind; rg)
      let fallbackCandidate: { readonly path: string; readonly version: string } | undefined;
      let belowFloorVersion: string | undefined;

      for (const candidatePath of findPathCandidates(name)) {
        if (signal?.aborted) return fail("cancelled", "operation cancelled");
        const probe = await probeVersion(candidatePath, name, signal);
        if (probe.cancelled) return fail("cancelled", "operation cancelled");
        if (probe.version === undefined) continue;

        if (probe.version === tool.version) {
          return { ok: true, path: candidatePath, version: probe.version };
        }

        if (compareSemver(probe.version, tool.minimumVersion) >= 0) {
          if (fallbackCandidate === undefined) {
            fallbackCandidate = { path: candidatePath, version: probe.version };
          }
        } else if (belowFloorVersion === undefined) {
          belowFloorVersion = probe.version;
        }
      }

      const fallbackResult = (why: string): AcquireResult | undefined => {
        if (fallbackCandidate === undefined) return undefined;
        return {
          ok: true,
          path: fallbackCandidate.path,
          version: fallbackCandidate.version,
          status: {
            level: "warning",
            message: `Using ${name} ${fallbackCandidate.version} from PATH instead of pinned ${tool.version} (${why}).`,
          },
        };
      };

      const belowFloorNote =
        belowFloorVersion !== undefined
          ? `; found ${name} ${belowFloorVersion} on PATH which is below ${tool.minimumVersion}`
          : "";

      // 3. Offline check (read at acquire time)
      if (isOfflineEnv(env, platform)) {
        const fallback = fallbackResult("offline mode is enabled");
        if (fallback !== undefined) return fallback;
        return fail("offline", `CODING_AGENT_OFFLINE is set${belowFloorNote}`);
      }

      // 4. Target check
      const targetKey = resolveTargetKey(platform, arch);
      if (targetKey === undefined) {
        const fallback = fallbackResult(`unsupported platform ${platform}/${arch}`);
        if (fallback !== undefined) return fallback;
        return fail(
          "unsupported-platform",
          `unsupported platform ${platform}/${arch}${belowFloorNote}`,
        );
      }

      const asset = tool.assets[targetKey];
      const url = `${downloadBaseUrl}/${tool.repo}/releases/download/${tool.tagPrefix}${tool.version}/${asset.asset}`;

      // 5. Download, verify, extract, install, and probe
      try {
        const archiveBytes = await downloadVerifiedArchive(url, asset, signal);
        const installedPath = await installArchive(name, tool, asset, archiveBytes, signal);
        return {
          ok: true,
          path: installedPath,
          version: tool.version,
          status: {
            level: "info",
            message: `Installed ${name} ${tool.version} to ${installedPath}.`,
          },
        };
      } catch (error) {
        if (error instanceof CancelledError || signal?.aborted) {
          return fail("cancelled", "operation cancelled");
        }

        if (error instanceof DownloadError) {
          const fallback = fallbackResult(formatCauseChain(error));
          if (fallback !== undefined) return fallback;
          return fail(error.reason, error);
        }

        return fail("install-failed", error);
      }
    } catch (error) {
      if (error instanceof CancelledError || signal?.aborted) {
        return fail("cancelled", "operation cancelled");
      }
      return fail("install-failed", error);
    }
  }

  async function acquire(
    name: ManagedToolName,
    acquireOptions?: AcquireOptions,
  ): Promise<AcquireResult> {
    const existing = resolved.get(name);
    if (existing !== undefined) return existing;

    const signal = acquireOptions?.signal;
    const tool = manifest.tools[name];
    if (signal?.aborted) {
      return cancelledAcquireResult(name, tool);
    }

    const pending = inFlight.get(name);
    if (pending !== undefined) {
      const result = await raceWithAbort(pending, signal, name, tool);
      if (result.ok) return result;
      // If the shared in-flight work was cancelled by another caller's signal while our signal is
      // still active, start a fresh attempt for this caller.
      if (result.reason === "cancelled" && !signal?.aborted) {
        return acquire(name, acquireOptions);
      }
      return result;
    }

    const work = acquireUncached(name, signal)
      .then((result) => {
        if (result.ok) {
          resolved.set(name, result);
        }
        return result;
      })
      .finally(() => {
        inFlight.delete(name);
      });
    inFlight.set(name, work);
    return work;
  }

  return { acquire };
}

function cancelledAcquireResult(name: ManagedToolName, tool: ManagedToolEntry): AcquireResult {
  return {
    ok: false,
    reason: "cancelled",
    message: formatAcquireFailureMessage(
      name,
      tool.version,
      tool.minimumVersion,
      "cancelled",
      "operation cancelled",
    ),
  };
}

function raceWithAbort(
  promise: Promise<AcquireResult>,
  signal: AbortSignal | undefined,
  name: ManagedToolName,
  tool: ManagedToolEntry,
): Promise<AcquireResult> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    return Promise.resolve(cancelledAcquireResult(name, tool));
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      resolve(cancelledAcquireResult(name, tool));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
}

function safeHomedir(): string | undefined {
  try {
    const dir = homedir();
    return dir === "" ? undefined : dir;
  } catch {
    return undefined;
  }
}
