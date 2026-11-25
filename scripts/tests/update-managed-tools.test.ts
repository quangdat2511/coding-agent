import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManagedToolsManifest,
  type GitHubRelease,
  parseReleaseForTool,
  updateManagedToolsManifest,
} from "../update-managed-tools.ts";

const HASH_PREFIX = "a".repeat(60);

function makeAssets(
  prefix: string,
  version: string,
  overrides: Partial<Record<string, { size?: number; digest?: string | null }>> = {},
  omitTargets: readonly string[] = [],
) {
  const targets = [
    ["aarch64-apple-darwin", "tar.gz", 1001, `${HASH_PREFIX}0001`],
    ["x86_64-apple-darwin", "tar.gz", 1002, `${HASH_PREFIX}0002`],
    ["aarch64-unknown-linux-musl", "tar.gz", 1003, `${HASH_PREFIX}0003`],
    ["x86_64-unknown-linux-musl", "tar.gz", 1004, `${HASH_PREFIX}0004`],
    ["aarch64-pc-windows-msvc", "zip", 1005, `${HASH_PREFIX}0005`],
    ["x86_64-pc-windows-msvc", "zip", 1006, `${HASH_PREFIX}0006`],
  ] as const;

  return targets
    .filter(([target]) => !omitTargets.includes(target))
    .map(([target, ext, defaultSize, defaultHash]) => {
      const name = `${prefix}${version}-${target}.${ext}`;
      const override = overrides[target];
      return {
        name,
        size: override?.size ?? defaultSize,
        digest: override && "digest" in override ? override.digest : `sha256:${defaultHash}`,
      };
    });
}

describe("parseReleaseForTool", () => {
  it("parses an fd release, strips the v tag prefix, and normalizes hashes to lowercase", () => {
    const release: GitHubRelease = {
      tag_name: "v10.6.0",
      assets: [
        ...makeAssets("fd-v", "10.6.0", {
          "x86_64-unknown-linux-musl": { digest: `sha256:${"ABCDEF01".repeat(8)}` },
        }),
        { name: "fd_10.6.0_amd64.deb", size: 999, digest: `sha256:${"1".repeat(64)}` },
      ],
    };

    const entry = parseReleaseForTool("fd", release);
    expect(entry.version).toBe("10.6.0");
    expect(entry.repo).toBe("sharkdp/fd");
    expect(entry.tagPrefix).toBe("v");
    expect(entry.minimumVersion).toBe("10.5.1");
    expect(entry.assets["linux-x64"]).toEqual({
      asset: "fd-v10.6.0-x86_64-unknown-linux-musl.tar.gz",
      bytes: 1004,
      sha256: "abcdef01".repeat(8),
    });
    expect(entry.assets["win32-x64"]).toEqual({
      asset: "fd-v10.6.0-x86_64-pc-windows-msvc.zip",
      bytes: 1006,
      sha256: `${HASH_PREFIX}0006`,
    });
  });

  it("parses an rg release with empty tagPrefix", () => {
    const release: GitHubRelease = {
      tag_name: "16.1.0",
      assets: makeAssets("ripgrep-", "16.1.0"),
    };

    const entry = parseReleaseForTool("rg", release);
    expect(entry.version).toBe("16.1.0");
    expect(entry.repo).toBe("BurntSushi/ripgrep");
    expect(entry.tagPrefix).toBe("");
    expect(entry.minimumVersion).toBe("13.0.0");
    expect(entry.assets["darwin-arm64"]).toEqual({
      asset: "ripgrep-16.1.0-aarch64-apple-darwin.tar.gz",
      bytes: 1001,
      sha256: `${HASH_PREFIX}0001`,
    });
  });

  it("fails when any of the six required targets is missing", () => {
    const release: GitHubRelease = {
      tag_name: "v10.5.2",
      assets: makeAssets("fd-v", "10.5.2", {}, ["x86_64-apple-darwin", "aarch64-pc-windows-msvc"]),
    };

    expect(() => parseReleaseForTool("fd", release)).toThrow(
      /missing required asset.*darwin-x64.*win32-arm64/i,
    );
  });

  it("fails when a required asset is missing a sha256 digest or has an invalid digest", () => {
    const missingDigest: GitHubRelease = {
      tag_name: "16.0.0",
      assets: makeAssets("ripgrep-", "16.0.0", {
        "x86_64-unknown-linux-musl": { digest: null },
      }),
    };
    expect(() => parseReleaseForTool("rg", missingDigest)).toThrow(/invalid sha256 digest/i);

    const shortDigest: GitHubRelease = {
      tag_name: "16.0.0",
      assets: makeAssets("ripgrep-", "16.0.0", {
        "x86_64-unknown-linux-musl": { digest: "sha256:deadbeef" },
      }),
    };
    expect(() => parseReleaseForTool("rg", shortDigest)).toThrow(/invalid sha256 digest/i);
  });

  it("fails when the release tag does not start with the expected tagPrefix or is below minimumVersion", () => {
    expect(() =>
      parseReleaseForTool("fd", {
        tag_name: "10.5.2",
        assets: makeAssets("fd-v", "10.5.2"),
      }),
    ).toThrow(/expected tag prefix "v"/i);

    expect(() =>
      parseReleaseForTool("fd", {
        tag_name: "v10.5.0",
        assets: makeAssets("fd-v", "10.5.0"),
      }),
    ).toThrow(/below minimumVersion 10\.5\.1/i);
  });
});

describe("buildManagedToolsManifest and updateManagedToolsManifest", () => {
  it("builds a schemaVersion 1 manifest for both fd and rg", () => {
    const manifest = buildManagedToolsManifest({
      fd: { tag_name: "v10.5.2", assets: makeAssets("fd-v", "10.5.2") },
      rg: { tag_name: "16.0.0", assets: makeAssets("ripgrep-", "16.0.0") },
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.tools)).toEqual(["fd", "rg"]);
    expect(manifest.tools.fd.version).toBe("10.5.2");
    expect(manifest.tools.rg.version).toBe("16.0.0");
  });

  it("fetches /releases/latest via injected fetch and writes formatted JSON to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "update-managed-tools-"));
    try {
      const manifestPath = join(dir, "managed-tools.json");
      const seenUrls: string[] = [];
      const seenAuth: (string | null)[] = [];

      const fetchImpl = async (url: string, init?: RequestInit) => {
        seenUrls.push(url);
        const headers = new Headers(init?.headers);
        seenAuth.push(headers.get("authorization"));

        if (url.includes("sharkdp/fd")) {
          return new Response(
            JSON.stringify({ tag_name: "v10.5.2", assets: makeAssets("fd-v", "10.5.2") }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("BurntSushi/ripgrep")) {
          return new Response(
            JSON.stringify({ tag_name: "16.0.0", assets: makeAssets("ripgrep-", "16.0.0") }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      };

      await updateManagedToolsManifest({
        manifestPath,
        fetchImpl,
        token: "test-token",
      });

      expect(seenUrls).toEqual([
        "https://api.github.com/repos/sharkdp/fd/releases/latest",
        "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      ]);
      expect(seenAuth).toEqual(["Bearer test-token", "Bearer test-token"]);

      const written = await readFile(manifestPath, "utf8");
      expect(written.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(written);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.tools.fd.version).toBe("10.5.2");
      expect(parsed.tools.rg.version).toBe("16.0.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
