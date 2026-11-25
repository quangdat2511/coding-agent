// Fetches the latest GitHub releases for fd and ripgrep and rewrites
// packages/tools/src/managed-tools.json. Run manually in a PR — never in CI.
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MANAGED_TOOL_NAMES = ["fd", "rg"] as const;
export type ManagedToolName = (typeof MANAGED_TOOL_NAMES)[number];

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
  readonly assets: Record<PlatformArchKey, ManagedToolAsset>;
}

export interface ManagedToolsManifest {
  readonly schemaVersion: 1;
  readonly tools: Record<ManagedToolName, ManagedToolEntry>;
}

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly digest?: string | null;
}

export interface GitHubRelease {
  readonly tag_name: string;
  readonly assets: readonly GitHubReleaseAsset[];
}

interface ToolSpec {
  readonly repo: string;
  readonly tagPrefix: string;
  readonly assetPrefix: string;
  readonly minimumVersion: string;
}

const TOOL_SPECS: Record<ManagedToolName, ToolSpec> = {
  fd: {
    repo: "sharkdp/fd",
    tagPrefix: "v",
    assetPrefix: "fd-v",
    minimumVersion: "10.5.1",
  },
  rg: {
    repo: "BurntSushi/ripgrep",
    tagPrefix: "",
    assetPrefix: "ripgrep-",
    minimumVersion: "13.0.0",
  },
};

const PLATFORM_TARGETS: readonly {
  readonly key: PlatformArchKey;
  readonly rustTarget: string;
  readonly ext: "tar.gz" | "zip";
}[] = [
  { key: "darwin-arm64", rustTarget: "aarch64-apple-darwin", ext: "tar.gz" },
  { key: "darwin-x64", rustTarget: "x86_64-apple-darwin", ext: "tar.gz" },
  { key: "linux-arm64", rustTarget: "aarch64-unknown-linux-musl", ext: "tar.gz" },
  { key: "linux-x64", rustTarget: "x86_64-unknown-linux-musl", ext: "tar.gz" },
  { key: "win32-arm64", rustTarget: "aarch64-pc-windows-msvc", ext: "zip" },
  { key: "win32-x64", rustTarget: "x86_64-pc-windows-msvc", ext: "zip" },
];

export const PLATFORM_ARCH_KEYS: readonly PlatformArchKey[] = PLATFORM_TARGETS.map((t) => t.key);

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_DIGEST_RE = /^sha256:([0-9a-fA-F]{64})$/;

const repoRoot = resolve(import.meta.dir, "..");
export const DEFAULT_MANIFEST_PATH = join(
  repoRoot,
  "packages",
  "tools",
  "src",
  "managed-tools.json",
);

function compareSemver(a: string, b: string): number {
  const matchA = SEMVER_RE.exec(a);
  const matchB = SEMVER_RE.exec(b);
  if (!matchA || !matchB) {
    throw new Error(`Invalid semver: "${a}" vs "${b}"`);
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(matchA[i]) - Number(matchB[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function parseReleaseForTool(
  toolName: ManagedToolName,
  release: GitHubRelease,
): ManagedToolEntry {
  const spec = TOOL_SPECS[toolName];
  if (!release.tag_name.startsWith(spec.tagPrefix)) {
    throw new Error(
      `${toolName}: release tag "${release.tag_name}" does not start with expected tag prefix "${spec.tagPrefix}"`,
    );
  }

  const version = release.tag_name.slice(spec.tagPrefix.length);
  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `${toolName}: release tag "${release.tag_name}" yields non-semver version "${version}"`,
    );
  }
  if (compareSemver(version, spec.minimumVersion) < 0) {
    throw new Error(
      `${toolName}: latest version ${version} is below minimumVersion ${spec.minimumVersion}`,
    );
  }

  const assetsByName = new Map<string, GitHubReleaseAsset>();
  for (const asset of release.assets) {
    assetsByName.set(asset.name, asset);
  }

  const missing: string[] = [];
  const resolvedAssets = {} as Record<PlatformArchKey, ManagedToolAsset>;

  for (const { key, rustTarget, ext } of PLATFORM_TARGETS) {
    const expectedName = `${spec.assetPrefix}${version}-${rustTarget}.${ext}`;
    const found = assetsByName.get(expectedName);
    if (!found) {
      missing.push(`${key} (${expectedName})`);
      continue;
    }

    if (!Number.isSafeInteger(found.size) || found.size <= 0) {
      throw new Error(
        `${toolName}: asset ${expectedName} has invalid byte size ${String(found.size)}`,
      );
    }

    const digestMatch =
      typeof found.digest === "string" ? SHA256_DIGEST_RE.exec(found.digest) : null;
    if (!digestMatch?.[1]) {
      throw new Error(
        `${toolName}: asset ${expectedName} has missing or invalid sha256 digest "${String(found.digest)}"`,
      );
    }

    resolvedAssets[key] = {
      asset: expectedName,
      bytes: found.size,
      sha256: digestMatch[1].toLowerCase(),
    };
  }

  if (missing.length > 0) {
    throw new Error(`${toolName} ${version}: missing required asset(s) for ${missing.join(", ")}`);
  }

  return {
    version,
    repo: spec.repo,
    tagPrefix: spec.tagPrefix,
    minimumVersion: spec.minimumVersion,
    assets: resolvedAssets,
  };
}

export function buildManagedToolsManifest(
  releases: Record<ManagedToolName, GitHubRelease>,
): ManagedToolsManifest {
  return {
    schemaVersion: 1,
    tools: {
      fd: parseReleaseForTool("fd", releases.fd),
      rg: parseReleaseForTool("rg", releases.rg),
    },
  };
}

export function formatManifest(manifest: ManagedToolsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchLatestRelease(
  repo: string,
  options: { readonly fetchImpl?: FetchFn; readonly token?: string } = {},
): Promise<GitHubRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "coding-agent-update-managed-tools",
  };
  if (options.token && options.token.trim() !== "") {
    headers.Authorization = `Bearer ${options.token.trim()}`;
  }

  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  }

  const body = (await response.json()) as Partial<GitHubRelease>;
  if (typeof body.tag_name !== "string" || !Array.isArray(body.assets)) {
    throw new Error(`Unexpected GitHub release payload from ${url}`);
  }

  return { tag_name: body.tag_name, assets: body.assets };
}

export async function updateManagedToolsManifest(
  options: {
    readonly manifestPath?: string;
    readonly fetchImpl?: FetchFn;
    readonly token?: string;
  } = {},
): Promise<ManagedToolsManifest> {
  const [fdRelease, rgRelease] = await Promise.all([
    fetchLatestRelease(TOOL_SPECS.fd.repo, options),
    fetchLatestRelease(TOOL_SPECS.rg.repo, options),
  ]);

  const manifest = buildManagedToolsManifest({ fd: fdRelease, rg: rgRelease });
  const targetPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  await writeFile(targetPath, formatManifest(manifest), "utf8");
  return manifest;
}

if (import.meta.main) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  try {
    const manifest = await updateManagedToolsManifest({ token });
    console.log(
      `Updated ${DEFAULT_MANIFEST_PATH}: fd ${manifest.tools.fd.version}, rg ${manifest.tools.rg.version}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`update-managed-tools: ${message}`);
    process.exit(1);
  }
}
