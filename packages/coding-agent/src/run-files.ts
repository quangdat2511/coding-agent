import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentResult,
  ApprovalPolicy,
  RunEvent,
  RunEventType,
  RunLimits,
} from "@coding-agent/agent-core";
import type { BuildInfo } from "./build-info.ts";
import type { Profile } from "./run-args.ts";
import type { SamplingSettings, VerificationConfig } from "./run-config.ts";

const SCHEMA_VERSION = 1;

export interface RunRecord {
  readonly codingAgent: BuildInfo;
  readonly provider: string;
  readonly model: string;
  readonly sampling: SamplingSettings;
  readonly transportRetryBound: number;
  readonly repoRoot: string;
  readonly profile: Profile;
  readonly limits: RunLimits;
  readonly approvalPolicy: ApprovalPolicy;
  readonly verification: VerificationConfig;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
}

export interface ResultRecord {
  readonly exitCode: number;
  readonly result: AgentResult;
  readonly finishedAt: string;
}

const OMITTED_EVENTS: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "assistant_content_delta",
  "tool_execution_progress",
  "verification_progress",
]);

export interface RunFiles {
  logEvents(events: AsyncIterable<RunEvent>): Promise<void>;
  writeResult(result: ResultRecord): Promise<void>;
  close(): Promise<void>;
  discard(): Promise<void>;
}

type Redact = (text: string) => string;

// Property names are redacted too: a provider error or a Tool Result can carry the value as one.
function redacted(value: unknown, redact: Redact): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redacted(item, redact));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [redact(name), redacted(item, redact)]),
  );
}

export async function openRunFiles(
  outputDir: string,
  run: RunRecord,
  redact: Redact,
): Promise<RunFiles> {
  const serialize = (content: object, indent?: number): string => {
    const versioned = { schemaVersion: SCHEMA_VERSION, ...content };
    return `${JSON.stringify(redacted(versioned, redact), null, indent)}\n`;
  };
  const remove = (name: string) => rm(join(outputDir, name), { force: true });
  // Renamed into place, so a reader never sees half a document, even after a kill.
  const writeDocument = async (name: string, content: object) => {
    const path = join(outputDir, name);
    const partial = `${path}.partial`;
    try {
      await writeFile(partial, serialize(content, 2));
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  // Otherwise an earlier run's result would stand in for a run killed before it settles.
  await remove("result.json");
  await writeDocument("run.json", run);
  const log = await open(join(outputDir, "events.jsonl"), "w").catch(async (error: unknown) => {
    await remove("run.json").catch(() => undefined);
    throw error;
  });
  return {
    async logEvents(events) {
      for await (const event of events) {
        if (OMITTED_EVENTS.has(event.type)) continue;
        await log.appendFile(serialize(event));
      }
    },
    writeResult: (result) => writeDocument("result.json", result),
    close: () => log.close(),
    async discard() {
      await log.close().catch(() => undefined);
      for (const name of ["run.json", "events.jsonl"]) await remove(name).catch(() => undefined);
    },
  };
}
