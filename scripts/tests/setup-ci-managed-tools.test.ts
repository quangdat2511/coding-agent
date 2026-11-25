import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installManagedToolsForHost,
  parseToolVersion,
  resolveHostTargetKey,
} from "../setup-ci-managed-tools.ts";
import type { ManagedToolsManifest, PlatformArchKey } from "../update-managed-tools.ts";

async function createFixtureArchive(
  workDir: string,
  topDirName: string,
  binaryName: string,
  binaryContent: string,
  format: "tar.gz" | "zip",
): Promise<{ bytes: number; sha256: string; archiveBytes: Uint8Array<ArrayBuffer> }> {
  const stageDir = join(workDir, `stage-${topDirName}`);
  const innerDir = join(stageDir, topDirName);
  await mkdir(innerDir, { recursive: true });
  const binPath = join(innerDir, binaryName);
  await writeFile(binPath, binaryContent, "utf8");
  if (process.platform !== "win32") {
    await chmod(binPath, 0o755);
  }

  const archivePath = join(workDir, `${topDirName}.${format}`);
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
  return { bytes: archiveBytes.byteLength, sha256, archiveBytes };
}

function makeManifestForHost(
  hostKey: PlatformArchKey,
  fdAsset: { asset: string; bytes: number; sha256: string },
  rgAsset: { asset: string; bytes: number; sha256: string },
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

describe("resolveHostTargetKey", () => {
  it("maps all six supported platform/arch pairs", () => {
    expect(resolveHostTargetKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(resolveHostTargetKey("darwin", "x64")).toBe("darwin-x64");
    expect(resolveHostTargetKey("linux", "arm64")).toBe("linux-arm64");
    expect(resolveHostTargetKey("linux", "x64")).toBe("linux-x64");
    expect(resolveHostTargetKey("win32", "arm64")).toBe("win32-arm64");
    expect(resolveHostTargetKey("win32", "x64")).toBe("win32-x64");
  });

  it("throws on unsupported platform or architecture", () => {
    expect(() => resolveHostTargetKey("freebsd", "x64")).toThrow(/unsupported platform/i);
    expect(() => resolveHostTargetKey("linux", "arm")).toThrow(/unsupported platform/i);
  });
});

describe("installManagedToolsForHost", () => {
  it("downloads from a local server, verifies sha256 and bytes, extracts, verifies version, and writes GITHUB_PATH", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "setup-ci-tools-"));
    const isWindows = process.platform === "win32";
    const hostKey = resolveHostTargetKey(process.platform, process.arch);
    const format = isWindows ? "zip" : "tar.gz";
    const ext = isWindows ? ".exe" : "";

    const fdArchive = await createFixtureArchive(
      workDir,
      "fd-v10.5.2-fixture",
      `fd${ext}`,
      "#!/bin/sh\necho 'fd 10.5.2'\n",
      format,
    );
    const rgArchive = await createFixtureArchive(
      workDir,
      "ripgrep-16.0.0-fixture",
      `rg${ext}`,
      "#!/bin/sh\necho 'ripgrep 16.0.0'\n",
      format,
    );

    const fdAssetName = `fd-v10.5.2-fixture.${format}`;
    const rgAssetName = `ripgrep-16.0.0-fixture.${format}`;
    const manifest = makeManifestForHost(
      hostKey,
      { asset: fdAssetName, bytes: fdArchive.bytes, sha256: fdArchive.sha256 },
      { asset: rgAssetName, bytes: rgArchive.bytes, sha256: rgArchive.sha256 },
    );

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === `/sharkdp/fd/releases/download/v10.5.2/${fdAssetName}`) {
          return new Response(fdArchive.archiveBytes);
        }
        if (pathname === `/BurntSushi/ripgrep/releases/download/16.0.0/${rgAssetName}`) {
          return new Response(rgArchive.archiveBytes);
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const binDir = join(workDir, "bin");
      const githubPathFile = join(workDir, "github-path.txt");

      const result = await installManagedToolsForHost({
        manifest,
        binDir,
        downloadBaseUrl: server.url.toString().replace(/\/$/, ""),
        githubPathFile,
        retryDelayMs: 1,
        // Windows cannot execute a shell-script stub named *.exe; verify real execution on Unix.
        verifyVersion: isWindows ? async () => {} : undefined,
      });

      expect(result.binDir).toBe(binDir);
      expect(result.installed.fd).toBe(join(binDir, `fd${ext}`));
      expect(result.installed.rg).toBe(join(binDir, `rg${ext}`));

      const fdStat = await stat(result.installed.fd);
      const rgStat = await stat(result.installed.rg);
      expect(fdStat.isFile()).toBe(true);
      expect(rgStat.isFile()).toBe(true);

      const githubPathContent = await readFile(githubPathFile, "utf8");
      expect(githubPathContent).toBe(`${binDir}\n`);
    } finally {
      server.stop(true);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects downloads whose SHA-256 hash does not match the manifest", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "setup-ci-tools-bad-hash-"));
    const hostKey = resolveHostTargetKey(process.platform, process.arch);
    const payload = new TextEncoder().encode("corrupted archive bytes");

    const manifest = makeManifestForHost(
      hostKey,
      { asset: "fd.tar.gz", bytes: payload.byteLength, sha256: "f".repeat(64) },
      { asset: "rg.tar.gz", bytes: payload.byteLength, sha256: "f".repeat(64) },
    );

    const fetchImpl = async () => new Response(payload, { status: 200 });

    try {
      await expect(
        installManagedToolsForHost({
          manifest,
          binDir: join(workDir, "bin"),
          fetchImpl,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow(/sha256 mismatch/i);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects downloads whose byte size does not match the manifest", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "setup-ci-tools-bad-size-"));
    const hostKey = resolveHostTargetKey(process.platform, process.arch);
    const payload = new TextEncoder().encode("short");

    const manifest = makeManifestForHost(
      hostKey,
      { asset: "fd.tar.gz", bytes: 99999, sha256: "f".repeat(64) },
      { asset: "rg.tar.gz", bytes: 99999, sha256: "f".repeat(64) },
    );

    const fetchImpl = async () => new Response(payload, { status: 200 });

    try {
      await expect(
        installManagedToolsForHost({
          manifest,
          binDir: join(workDir, "bin"),
          fetchImpl,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow(/size mismatch/i);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("aborts streaming early when response chunks exceed manifest bytes", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "setup-ci-tools-stream-cap-"));
    const hostKey = resolveHostTargetKey(process.platform, process.arch);

    const manifest = makeManifestForHost(
      hostKey,
      { asset: "fd.tar.gz", bytes: 10, sha256: "f".repeat(64) },
      { asset: "rg.tar.gz", bytes: 10, sha256: "f".repeat(64) },
    );

    let chunksPulled = 0;
    let cancelCalled = false;

    const fetchImpl = async () => {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            chunksPulled++;
            controller.enqueue(new Uint8Array(8));
          },
          cancel() {
            cancelCalled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, { status: 200 });
    };

    try {
      await expect(
        installManagedToolsForHost({
          manifest,
          binDir: join(workDir, "bin"),
          fetchImpl,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow(/exceeded expected 10 bytes/i);

      expect(cancelCalled).toBe(true);
      // 3 attempts * 2 chunks (8 + 8 = 16 > 10) = 6 pulls; never drains unboundedly.
      expect(chunksPulled).toBeLessThanOrEqual(6);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("accepts a gzip-encoded HTTP response whose compressed Content-Length exceeds decoded manifest bytes", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "setup-ci-tools-gzip-"));
    const isWindows = process.platform === "win32";
    const hostKey = resolveHostTargetKey(process.platform, process.arch);
    const format = isWindows ? "zip" : "tar.gz";
    const ext = isWindows ? ".exe" : "";

    const fdArchive = await createFixtureArchive(
      workDir,
      "fd-v10.5.2-fixture",
      `fd${ext}`,
      "#!/bin/sh\necho 'fd 10.5.2'\n",
      format,
    );
    const rgArchive = await createFixtureArchive(
      workDir,
      "ripgrep-16.0.0-fixture",
      `rg${ext}`,
      "#!/bin/sh\necho 'ripgrep 16.0.0'\n",
      format,
    );

    // Level 0 (stored gzip) always adds gzip framing overhead so wire Content-Length exceeds decoded
    // bytes on every OS (including Windows .zip fixtures that would otherwise shrink at default level).
    const fdGzip = Bun.gzipSync(fdArchive.archiveBytes, { level: 0 });
    const rgGzip = Bun.gzipSync(rgArchive.archiveBytes, { level: 0 });
    expect(fdGzip.byteLength).toBeGreaterThan(fdArchive.bytes);
    expect(rgGzip.byteLength).toBeGreaterThan(rgArchive.bytes);

    const fdAssetName = `fd-v10.5.2-fixture.${format}`;
    const rgAssetName = `ripgrep-16.0.0-fixture.${format}`;
    const manifest = makeManifestForHost(
      hostKey,
      { asset: fdAssetName, bytes: fdArchive.bytes, sha256: fdArchive.sha256 },
      { asset: rgAssetName, bytes: rgArchive.bytes, sha256: rgArchive.sha256 },
    );

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === `/sharkdp/fd/releases/download/v10.5.2/${fdAssetName}`) {
          return new Response(fdGzip, {
            headers: {
              "Content-Encoding": "gzip",
              "Content-Length": String(fdGzip.byteLength),
            },
          });
        }
        if (pathname === `/BurntSushi/ripgrep/releases/download/16.0.0/${rgAssetName}`) {
          return new Response(rgGzip, {
            headers: {
              "Content-Encoding": "gzip",
              "Content-Length": String(rgGzip.byteLength),
            },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const result = await installManagedToolsForHost({
        manifest,
        binDir: join(workDir, "bin"),
        downloadBaseUrl: server.url.toString().replace(/\/$/, ""),
        retryDelayMs: 1,
        // Windows cannot execute a shell-script stub named *.exe; verify real execution on Unix.
        verifyVersion: isWindows ? async () => {} : undefined,
      });

      expect(result.installed.fd).toBe(join(workDir, "bin", `fd${ext}`));
      expect(result.installed.rg).toBe(join(workDir, "bin", `rg${ext}`));
    } finally {
      server.stop(true);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // Skipped on Windows: the fixture binary is a POSIX shell script (`#!/bin/sh`), which Windows
  // cannot execute as a `.exe` during `--version` verification.
  it.skipIf(process.platform === "win32")(
    "rejects a binary whose --version output has a prefix match like 10.5.20 for pinned 10.5.2",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "setup-ci-tools-version-mismatch-"));
      const hostKey = resolveHostTargetKey(process.platform, process.arch);

      const fdArchive = await createFixtureArchive(
        workDir,
        "fd-v10.5.2-fixture",
        "fd",
        "#!/bin/sh\necho 'fd 10.5.20'\n",
        "tar.gz",
      );
      const rgArchive = await createFixtureArchive(
        workDir,
        "ripgrep-16.0.0-fixture",
        "rg",
        "#!/bin/sh\necho 'ripgrep 16.0.0'\n",
        "tar.gz",
      );

      const manifest = makeManifestForHost(
        hostKey,
        {
          asset: "fd-v10.5.2-fixture.tar.gz",
          bytes: fdArchive.bytes,
          sha256: fdArchive.sha256,
        },
        {
          asset: "ripgrep-16.0.0-fixture.tar.gz",
          bytes: rgArchive.bytes,
          sha256: rgArchive.sha256,
        },
      );

      const fetchImpl = async (url: string) =>
        new Response(url.includes("sharkdp/fd") ? fdArchive.archiveBytes : rgArchive.archiveBytes, {
          status: 200,
        });

      try {
        await expect(
          installManagedToolsForHost({
            manifest,
            binDir: join(workDir, "bin"),
            fetchImpl,
            retryDelayMs: 1,
          }),
        ).rejects.toThrow(/expected exact version 10\.5\.2/i);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );
});

describe("parseToolVersion", () => {
  it("extracts exact semver from fd and ripgrep --version output", () => {
    expect(parseToolVersion("fd", "fd 10.5.2\n")).toBe("10.5.2");
    expect(parseToolVersion("fd", "fd 10.5.20\n")).toBe("10.5.20");
    expect(parseToolVersion("rg", "ripgrep 16.0.0\n-SIMD -AVX (compiled)\n")).toBe("16.0.0");
    expect(parseToolVersion("rg", "fd 16.0.0\n")).toBeUndefined();
  });
});
