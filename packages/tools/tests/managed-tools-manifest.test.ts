import { describe, expect, it } from "bun:test";
import manifest from "../src/managed-tools.json";

const EXPECTED_TARGETS = {
  "darwin-arm64": { rustTarget: "aarch64-apple-darwin", ext: "tar.gz" },
  "darwin-x64": { rustTarget: "x86_64-apple-darwin", ext: "tar.gz" },
  "linux-arm64": { rustTarget: "aarch64-unknown-linux-musl", ext: "tar.gz" },
  "linux-x64": { rustTarget: "x86_64-unknown-linux-musl", ext: "tar.gz" },
  "win32-arm64": { rustTarget: "aarch64-pc-windows-msvc", ext: "zip" },
  "win32-x64": { rustTarget: "x86_64-pc-windows-msvc", ext: "zip" },
} as const;

const EXPECTED_TOOLS = {
  fd: { repo: "sharkdp/fd", tagPrefix: "v", assetPrefix: "fd-v", floor: "10.5.1" },
  rg: { repo: "BurntSushi/ripgrep", tagPrefix: "", assetPrefix: "ripgrep-", floor: "13.0.0" },
} as const;

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

describe("managed-tools.json manifest", () => {
  it("uses schemaVersion 1 and declares exactly fd and rg", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.tools).sort()).toEqual(["fd", "rg"]);
  });

  for (const [toolName, expected] of Object.entries(EXPECTED_TOOLS)) {
    describe(toolName, () => {
      const tool = manifest.tools[toolName as keyof typeof manifest.tools];

      it("has valid metadata and minimumVersion no higher than version", () => {
        expect(tool.repo).toBe(expected.repo);
        expect(tool.tagPrefix).toBe(expected.tagPrefix);
        expect(tool.version).toMatch(SEMVER_RE);
        expect(tool.minimumVersion).toMatch(SEMVER_RE);
        expect(tool.minimumVersion).toBe(expected.floor);
        expect(Bun.semver.order(tool.minimumVersion, tool.version)).toBeLessThanOrEqual(0);
      });

      it("has all six supported platform/arch targets with valid asset names, sizes, and 64-hex SHA-256 hashes", () => {
        expect(Object.keys(tool.assets).sort()).toEqual(Object.keys(EXPECTED_TARGETS).sort());

        for (const [platformKey, { rustTarget, ext }] of Object.entries(EXPECTED_TARGETS)) {
          const entry = tool.assets[platformKey as keyof typeof tool.assets];
          expect(entry.asset).toBe(`${expected.assetPrefix}${tool.version}-${rustTarget}.${ext}`);
          expect(Number.isSafeInteger(entry.bytes)).toBe(true);
          expect(entry.bytes).toBeGreaterThan(0);
          expect(entry.sha256).toMatch(SHA256_RE);
        }
      });
    });
  }
});
