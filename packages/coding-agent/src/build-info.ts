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
