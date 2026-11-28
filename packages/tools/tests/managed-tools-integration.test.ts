import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildProcessLauncher } from "../src/child-process.ts";
import {
  createToolAcquirer,
  type ManagedToolsManifest,
  type PlatformArchKey,
  resolveTargetKey,
} from "../src/managed-tools.ts";
import { noModeBits } from "./platform.ts";

async function createExecutableFixture(
  workDir: string,
  destPath: string,
  versionLine: string,
): Promise<void> {
  if (process.platform !== "win32") {
    await writeFile(destPath, `#!/bin/sh\necho '${versionLine}'\n`, "utf8");
    await chmod(destPath, 0o755);
    return;
  }

  // On Windows, compile a tiny standalone executable so ChildProcessLauncher can run `--version`
  // directly without a shell wrapper.
  const srcPath = join(workDir, `fixture-${Math.random().toString(36).slice(2)}.ts`);
  await writeFile(srcPath, `console.log(${JSON.stringify(versionLine)});\n`, "utf8");
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      srcPath,
      "--outfile",
      destPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to compile Windows fixture executable: ${stderr}`);
  }
}

async function createFixtureArchive(
  workDir: string,
  topDirName: string,
  binaryName: string,
  versionLine: string,
  format: "tar.gz" | "zip",
): Promise<{
  readonly asset: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly archiveBytes: Uint8Array<ArrayBuffer>;
}> {
  const stageDir = join(workDir, `stage-${topDirName}`);
  const innerDir = join(stageDir, topDirName);
  await mkdir(innerDir, { recursive: true });
  const binPath = join(innerDir, binaryName);
  await createExecutableFixture(workDir, binPath, versionLine);

  const asset = `${topDirName}.${format}`;
  const archivePath = join(workDir, asset);
  const cmd =
    format === "tar.gz"
      ? ["tar", "-czf", archivePath, "-C", stageDir, topDirName]
      : [
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
          "-a",
          "-cf",
          archivePath,
          "-C",
          stageDir,
          topDirName,
        ];

  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to build fixture archive (${cmd.join(" ")}): ${stderr}`);
  }

  const archiveBytes = new Uint8Array(await readFile(archivePath));
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  return { asset, bytes: archiveBytes.byteLength, sha256, archiveBytes };
}

function makeManifestForHost(
  hostKey: PlatformArchKey,
  fdAsset: { readonly asset: string; readonly bytes: number; readonly sha256: string },
  rgAsset: { readonly asset: string; readonly bytes: number; readonly sha256: string },
): ManagedToolsManifest {
  const placeholder = { asset: "unused.tar.gz", bytes: 1, sha256: "0".repeat(64) };
  const baseAssets = {
    "darwin-arm64": placeholder,
    "darwin-x64": placeholder,
    "linux-arm64": placeholder,
    "linux-x64": placeholder,
    "win32-arm64": placeholder,
    "win32-x64": placeholder,
  };
  return {
    schemaVersion: 1,
    tools: {
      fd: {
        version: "10.5.2",
        repo: "sharkdp/fd",
        tagPrefix: "v",
        minimumVersion: "10.5.1",
        assets: { ...baseAssets, [hostKey]: fdAsset },
      },
      rg: {
        version: "16.0.0",
        repo: "BurntSushi/ripgrep",
        tagPrefix: "",
        minimumVersion: "13.0.0",
        assets: { ...baseAssets, [hostKey]: rgAsset },
      },
    },
  };
}

describe("managed-tools integration (local Bun.serve)", () => {
  const hostKey = resolveTargetKey(process.platform, process.arch);

  // Skip on hosts whose platform/arch is not one of the six supported managed binary targets.
  it.skipIf(hostKey === undefined)(
    "downloads, verifies, extracts, installs, and caches both fd and rg from a local server",
    async () => {
      if (hostKey === undefined) return;

      const workDir = await mkdtemp(join(tmpdir(), "coding-agent-acquirer-it-"));
      const cacheDir = join(workDir, "cache");
      const isWindows = process.platform === "win32";
      const format = isWindows ? "zip" : "tar.gz";
      const ext = isWindows ? ".exe" : "";

      let server: ReturnType<typeof Bun.serve> | undefined;
      try {
        const [fdFixture, rgFixture] = await Promise.all([
          createFixtureArchive(workDir, "fd-v10.5.2-fixture", `fd${ext}`, "fd 10.5.2", format),
          createFixtureArchive(
            workDir,
            "ripgrep-16.0.0-fixture",
            `rg${ext}`,
            "ripgrep 16.0.0",
            format,
          ),
        ]);

        const routes = new Map<string, Uint8Array<ArrayBuffer>>([
          [`/sharkdp/fd/releases/download/v10.5.2/${fdFixture.asset}`, fdFixture.archiveBytes],
          [
            `/BurntSushi/ripgrep/releases/download/16.0.0/${rgFixture.asset}`,
            rgFixture.archiveBytes,
          ],
        ]);
        const hits: string[] = [];

        server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(req) {
            const path = new URL(req.url).pathname;
            hits.push(path);
            const body = routes.get(path);
            if (!body) return new Response("not found", { status: 404 });
            return new Response(body, {
              headers: { "Content-Length": String(body.byteLength) },
            });
          },
        });

        const launcherResult = createChildProcessLauncher(["OPENAI_API_KEY"]);
        expect(launcherResult.ok).toBe(true);
        if (!launcherResult.ok) return;

        const manifest = makeManifestForHost(
          hostKey,
          { asset: fdFixture.asset, bytes: fdFixture.bytes, sha256: fdFixture.sha256 },
          { asset: rgFixture.asset, bytes: rgFixture.bytes, sha256: rgFixture.sha256 },
        );

        // Explicitly override CODING_AGENT_OFFLINE=0 (CI sets it to 1) and clear PATH so both
        // tools must be acquired from our local server.
        const acquirer = createToolAcquirer({
          launcher: launcherResult.launcher,
          env: {
            ...process.env,
            PATH: "",
            Path: "",
            CODING_AGENT_OFFLINE: "0",
          },
          platform: process.platform,
          arch: process.arch,
          cacheDir,
          manifest,
          downloadBaseUrl: server.url.toString().replace(/\/$/, ""),
        });

        const [fdResult, rgResult] = await Promise.all([
          acquirer.acquire("fd"),
          acquirer.acquire("rg"),
        ]);

        expect(fdResult.ok).toBe(true);
        expect(rgResult.ok).toBe(true);
        if (!fdResult.ok || !rgResult.ok) return;

        expect(fdResult.path).toBe(join(cacheDir, "bin", "fd", "10.5.2", `fd${ext}`));
        expect(fdResult.version).toBe("10.5.2");
        expect(fdResult.status?.level).toBe("info");

        expect(rgResult.path).toBe(join(cacheDir, "bin", "rg", "16.0.0", `rg${ext}`));
        expect(rgResult.version).toBe("16.0.0");
        expect(rgResult.status?.level).toBe("info");

        expect(hits).toHaveLength(2);

        // Verify POSIX permissions on binary and temp dir cleanup.
        if (!noModeBits) {
          const fdStat = await stat(fdResult.path);
          expect(fdStat.mode & 0o777).toBe(0o755);
          const rgStat = await stat(rgResult.path);
          expect(rgStat.mode & 0o777).toBe(0o755);
        }
        const remainingTmp = await readdir(join(cacheDir, "tmp"));
        expect(remainingTmp).toEqual([]);

        // A fresh acquirer instance with CODING_AGENT_OFFLINE=1 hits the populated cache with no
        // network requests.
        const offlineAcquirer = createToolAcquirer({
          launcher: launcherResult.launcher,
          env: {
            ...process.env,
            PATH: "",
            Path: "",
            CODING_AGENT_OFFLINE: "1",
          },
          platform: process.platform,
          arch: process.arch,
          cacheDir,
          manifest,
          downloadBaseUrl: server.url.toString().replace(/\/$/, ""),
        });

        const cachedFd = await offlineAcquirer.acquire("fd");
        const cachedRg = await offlineAcquirer.acquire("rg");
        expect(cachedFd).toEqual({ ok: true, path: fdResult.path, version: "10.5.2" });
        expect(cachedRg).toEqual({ ok: true, path: rgResult.path, version: "16.0.0" });
        expect(hits).toHaveLength(2);
      } finally {
        server?.stop(true);
        await rm(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
