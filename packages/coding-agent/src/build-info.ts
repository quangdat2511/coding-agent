import manifest from "../package.json" with { type: "json" };

// Replaced with the source commit by `bun build --define`; a run from source has none.
declare const CODING_AGENT_COMMIT: string | undefined;

export interface BuildInfo {
  readonly version: string;
  readonly commit: string | null;
}

export const BUILD_INFO: BuildInfo = Object.freeze({
  version: manifest.version,
  commit: typeof CODING_AGENT_COMMIT === "string" ? CODING_AGENT_COMMIT : null,
});

// The line `coding-agent --version` prints, without its newline. The artifact build compares it
// with the manifest it writes (ADR 0005 §2), so a build from source, which has no commit, says so.
export const formatVersion = (info: BuildInfo): string =>
  `coding-agent ${info.version} ${info.commit ?? "(no commit)"}`;
