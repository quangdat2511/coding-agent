// Installs the pinned managed binaries (fd, rg) from packages/tools/src/managed-tools.json
// into a temporary directory for CI jobs, verifies byte size (bounded while streaming) and
// SHA-256 before extraction, checks `--version`, and adds the directory to GITHUB_PATH.
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MANIFEST_PATH,
  type FetchFn,
  MANAGED_TOOL_NAMES,
  type ManagedToolAsset,
  type ManagedToolName,
  type ManagedToolsManifest,
  PLATFORM_ARCH_KEYS,
  type PlatformArchKey,
} from "./update-managed-tools.ts";

const SUPPORTED_KEYS = new Set<PlatformArchKey>(PLATFORM_ARCH_KEYS);
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

const VERSION_LINE_PREFIX: Record<ManagedToolName, string> = {
  fd: "fd",
  rg: "ripgrep",
};

class NonRetryableDownloadError extends Error {}

export function resolveHostTargetKey(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformArchKey {
  const key = `${platform}-${arch}` as PlatformArchKey;
  if (!SUPPORTED_KEYS.has(key)) {
    throw new Error(`Unsupported platform/arch for managed binaries: ${platform}/${arch}`);
  }
  return key;
}

export function parseToolVersion(toolName: ManagedToolName, stdout: string): string | undefined {
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const prefix = VERSION_LINE_PREFIX[toolName];
  const match = new RegExp(`^${prefix}\\s+(\\d+\\.\\d+\\.\\d+)(?:\\s|$)`).exec(firstLine);
  return match?.[1];
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
}

async function readBoundedResponse(
  response: Response,
  url: string,
  asset: ManagedToolAsset,
): Promise<Uint8Array> {
  // Content-Length reflects the wire payload before decoding Content-Encoding, so only compare it
  // against the decoded archive size when no transfer/content encoding is applied.
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const isUnencoded = !contentEncoding || contentEncoding === "identity";
  const contentLengthHeader = isUnencoded ? response.headers.get("content-length") : null;
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > asset.bytes) {
      await response.body?.cancel();
      throw new Error(
        `Size mismatch for ${url}: Content-Length ${declaredLength} exceeds expected ${asset.bytes} bytes`,
      );
    }
  }

  const hash = createHash("sha256");
  const buffer = new Uint8Array(asset.bytes);
  let totalBytes = 0;

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        if (totalBytes + value.byteLength > asset.bytes) {
          await reader.cancel();
          throw new Error(
            `Size mismatch for ${url}: response exceeded expected ${asset.bytes} bytes`,
          );
        }

        buffer.set(value, totalBytes);
        totalBytes += value.byteLength;
        hash.update(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (totalBytes !== asset.bytes) {
    throw new Error(`Size mismatch for ${url}: expected ${asset.bytes} bytes, got ${totalBytes}`);
  }

  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== asset.sha256) {
    throw new Error(`SHA256 mismatch for ${url}: expected ${asset.sha256}, got ${actualSha256}`);
  }

  return buffer;
}

async function downloadAndVerify(
  url: string,
  asset: ManagedToolAsset,
  fetchImpl: FetchFn,
  retryDelayMs: number,
): Promise<Uint8Array> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "coding-agent-ci-setup" },
      });

      if (!response.ok) {
        await response.body?.cancel();
        const message = `HTTP ${response.status} downloading ${url}`;
        throw isRetryableStatus(response.status)
          ? new Error(message)
          : new NonRetryableDownloadError(message);
      }

      return await readBoundedResponse(response, url, asset);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err instanceof NonRetryableDownloadError || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      lastError = err;
      await Bun.sleep(retryDelayMs * attempt);
    }
  }

  throw lastError ?? new Error(`Failed to download ${url}`);
}

async function runCommand(cmd: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function extractArchive(
  archivePath: string,
  extractDir: string,
  platform: string,
): Promise<void> {
  if (platform !== "win32") {
    const result = await runCommand(["tar", "-xzf", archivePath, "-C", extractDir]);
    if (result.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return;
  }

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const tarExe = join(systemRoot, "System32", "tar.exe");
  let tarFailure = "";
  try {
    const tarResult = await runCommand([tarExe, "-xf", archivePath, "-C", extractDir]);
    if (tarResult.exitCode === 0) return;
    tarFailure = tarResult.stderr.trim();
  } catch (error) {
    tarFailure = error instanceof Error ? error.message : String(error);
  }

  const psEscape = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const psResult = await runCommand([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath ${psEscape(archivePath)} -DestinationPath ${psEscape(extractDir)} -Force`,
  ]);
  if (psResult.exitCode !== 0) {
    throw new Error(
      `Windows extraction failed. tar.exe: ${tarFailure}; Expand-Archive: ${psResult.stderr.trim()}`,
    );
  }
}

async function findBinaryRecursive(dir: string, binaryName: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && entry.name === binaryName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = await findBinaryRecursive(fullPath, binaryName);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function defaultVerifyVersion(
  binaryPath: string,
  toolName: ManagedToolName,
  expectedVersion: string,
): Promise<void> {
  const result = await runCommand([binaryPath, "--version"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `${toolName} --version exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  const actualVersion = parseToolVersion(toolName, result.stdout);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${toolName} --version reported "${result.stdout.trim()}", expected exact version ${expectedVersion}`,
    );
  }
}

export interface InstallManagedToolsOptions {
  readonly manifest?: ManagedToolsManifest;
  readonly binDir?: string;
  readonly downloadBaseUrl?: string;
  readonly fetchImpl?: FetchFn;
  readonly githubPathFile?: string;
  readonly retryDelayMs?: number;
  readonly verifyVersion?: (
    binaryPath: string,
    toolName: ManagedToolName,
    expectedVersion: string,
  ) => Promise<void>;
}

export interface InstallManagedToolsResult {
  readonly binDir: string;
  readonly installed: Record<ManagedToolName, string>;
}

export async function installManagedToolsForHost(
  options: InstallManagedToolsOptions = {},
): Promise<InstallManagedToolsResult> {
  const platform = process.platform;
  const hostKey = resolveHostTargetKey(platform, process.arch);

  const manifest: ManagedToolsManifest =
    options.manifest ??
    (JSON.parse(await readFile(DEFAULT_MANIFEST_PATH, "utf8")) as ManagedToolsManifest);

  const fetchImpl = options.fetchImpl ?? fetch;
  const downloadBaseUrl = (options.downloadBaseUrl ?? "https://github.com").replace(/\/$/, "");
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const verifyVersion = options.verifyVersion ?? defaultVerifyVersion;

  const baseTemp = process.env.RUNNER_TEMP ?? tmpdir();
  const binDir = options.binDir ?? (await mkdtemp(join(baseTemp, "coding-agent-managed-bins-")));
  await mkdir(binDir, { recursive: true });

  const installed = {} as Record<ManagedToolName, string>;

  for (const toolName of MANAGED_TOOL_NAMES) {
    const tool = manifest.tools[toolName];
    const assetEntry = tool.assets[hostKey];
    const url = `${downloadBaseUrl}/${tool.repo}/releases/download/${tool.tagPrefix}${tool.version}/${assetEntry.asset}`;

    const archiveBytes = await downloadAndVerify(url, assetEntry, fetchImpl, retryDelayMs);

    const scratchDir = await mkdtemp(join(baseTemp, `coding-agent-extract-${toolName}-`));
    try {
      const archivePath = join(scratchDir, assetEntry.asset);
      const extractDir = join(scratchDir, "extracted");
      await mkdir(extractDir, { recursive: true });
      await writeFile(archivePath, archiveBytes);

      await extractArchive(archivePath, extractDir, platform);

      const binaryName = platform === "win32" ? `${toolName}.exe` : toolName;
      const extractedBinary = await findBinaryRecursive(extractDir, binaryName);
      if (!extractedBinary) {
        throw new Error(`Could not find ${binaryName} inside ${assetEntry.asset}`);
      }

      const destPath = join(binDir, binaryName);
      await copyFile(extractedBinary, destPath);
      if (platform !== "win32") {
        await chmod(destPath, 0o755);
      }

      await verifyVersion(destPath, toolName, tool.version);
      installed[toolName] = destPath;
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  const githubPathFile = options.githubPathFile ?? process.env.GITHUB_PATH;
  if (githubPathFile) {
    await appendFile(githubPathFile, `${binDir}\n`, "utf8");
  }

  return { binDir, installed };
}

if (import.meta.main) {
  try {
    const result = await installManagedToolsForHost();
    console.log(
      `Installed managed binaries into ${result.binDir}: fd=${result.installed.fd}, rg=${result.installed.rg}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`setup-ci-managed-tools: ${message}`);
    process.exit(1);
  }
}
