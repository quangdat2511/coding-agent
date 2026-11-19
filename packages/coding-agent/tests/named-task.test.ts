import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationFeedback } from "@coding-agent/agent-core";
import { runnerChainIsClean } from "./support/ancestor-chain.ts";
import { type LoggedEvent, loggedEvents, verificationsOf } from "./support/event-log.ts";
import { NAMED_TASK_FILE, NAMED_TASK_REPO, NAMED_TASK_RUN } from "./support/named-task.ts";
import { bunLikeShebang, firstLine, runProcess } from "./support/process.ts";
import { REPLAY_FIXTURES_ENV_VAR } from "./support/recorded-provider.ts";

// The run is under "auto-approve", so on Linux it meets the ancestor check first.
const cleanChain = await runnerChainIsClean();

const bin = join(import.meta.dir, "..", "src", "cli.ts");

// The preloads inject the recorded responses, the clock and the identifiers, so the arguments after
// `bin` are the real command line.
const preloads = ["replay-provider.ts", "fixed-clock-and-ids.ts"].flatMap((name) => [
  "--preload",
  join(import.meta.dir, "support", name),
]);

const credential = "not-a-real-credential";

interface NamedTaskRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly repo: string;
  readonly outputDir: string;
}

async function runNamedTask(directory: string): Promise<NamedTaskRun> {
  const repo = join(directory, "repo");
  const outputDir = join(directory, "out");
  await mkdir(directory, { recursive: true });
  await cp(NAMED_TASK_REPO, repo, { recursive: true });
  const finished = await runProcess(
    [
      ...bunLikeShebang,
      ...preloads,
      bin,
      "run",
      "--task-file",
      NAMED_TASK_FILE,
      "--provider",
      NAMED_TASK_RUN.provider,
      "--model",
      NAMED_TASK_RUN.model,
      "--approval-policy",
      "auto-approve",
      "--output-dir",
      outputDir,
      "--repo-root",
      repo,
    ],
    {
      cwd: directory,
      env: {
        GOOGLE_API_KEY: credential,
        CODING_AGENT_VERIFICATION_COMMAND: NAMED_TASK_RUN.verificationCommand,
        [REPLAY_FIXTURES_ENV_VAR]: NAMED_TASK_RUN.fixtures.join(","),
      },
    },
  );
  return { ...finished, repo, outputDir };
}

const verificationOutcomes = async (outputDir: string) =>
  (await verificationsOf(outputDir)).map(({ data }) => data.outcome);

function feedbackText({ data }: LoggedEvent): string {
  const { content } = data.feedback as VerificationFeedback;
  return typeof content === "string"
    ? content
    : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

// No evidence: `bun test` prints its own timings, and the Verification Runner uses the real clock.
async function replayedOutcome(run: NamedTaskRun) {
  const result = await Bun.file(join(run.outputDir, "result.json")).json();
  return {
    exitCode: run.exitCode,
    finishedAt: result.finishedAt,
    outcome: result.result.outcome,
    events: (await loggedEvents(run.outputDir)).map(({ sessionId, occurredAt, type }) => ({
      sessionId,
      occurredAt,
      type,
    })),
    verifications: await verificationOutcomes(run.outputDir),
    slugify: await Bun.file(join(run.repo, "src", "slugify.ts")).text(),
    testFile: await Bun.file(join(run.repo, "src", "slugify.test.ts")).text(),
  };
}

describe.skipIf(!cleanChain)("the named task, replayed end to end", () => {
  let directory = "";
  let first: NamedTaskRun;
  let second: NamedTaskRun;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "coding-agent-test-"));
    [first, second] = await Promise.all([
      runNamedTask(join(directory, "first")),
      runNamedTask(join(directory, "second")),
    ]);
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("exits 0 and writes the three files", async () => {
    expect(firstLine(first.stderr)).toBe("coding-agent: succeeded; workspace changed: yes");
    expect(first.exitCode).toBe(0);
    expect((await readdir(first.outputDir)).sort()).toEqual([
      "events.jsonl",
      "result.json",
      "run.json",
    ]);
    expect((await loggedEvents(first.outputDir)).at(-1)?.type).toBe("session_settled");
    expect(await Bun.file(join(first.outputDir, "run.json")).json()).toMatchObject({
      verification: { command: NAMED_TASK_RUN.verificationCommand },
      tools: ["read", "write", "edit", "bash"],
    });
    expect(first.stdout + first.stderr).not.toContain(credential);
  });

  it("leaves the new test in the repository, and the verification command passes", async () => {
    const testFile = await Bun.file(join(first.repo, "src", "slugify.test.ts")).text();
    expect(testFile).toContain("Hello, World!");
    expect(testFile).toContain("hello-world");

    const verification = await runProcess([process.execPath, "test"], { cwd: first.repo });
    expect(verification.stderr).toContain(" 1 pass");
    expect(verification.exitCode).toBe(0);
  });

  it("fails Verification with [Verification Failed] feedback, then passes it", async () => {
    const outcomes = await verificationOutcomes(first.outputDir);
    expect(outcomes.at(-1)).toBe("succeeded");
    expect(outcomes.slice(0, -1)).toContain("continue");
    expect(outcomes.slice(0, -1).every((outcome) => outcome === "continue")).toBe(true);

    const failed = (await verificationsOf(first.outputDir)).find(
      ({ data }) => data.outcome === "continue",
    );
    if (failed === undefined) throw new Error("no failing Verification was logged");
    expect(feedbackText(failed)).toStartWith("[Verification Failed]\n");
    expect(feedbackText(failed)).toContain(`Command: "${NAMED_TASK_RUN.verificationCommand}"\n`);
    const later = (await loggedEvents(first.outputDir)).filter(
      ({ sequence }) => sequence > failed.sequence,
    );
    expect(later.map(({ type }) => type)).toContain("model_turn_started");
  });

  it("logs the injected clock and identifiers", async () => {
    const events = await loggedEvents(first.outputDir);
    const { finishedAt } = await Bun.file(join(first.outputDir, "result.json")).json();
    expect(new Set(events.map(({ sessionId }) => sessionId))).toEqual(new Set(["session-1"]));
    expect(new Set(events.map(({ occurredAt }) => occurredAt))).toEqual(new Set([finishedAt]));
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(await Bun.file(join(first.outputDir, "events.jsonl")).text()).not.toMatch(uuid);
  });

  it("reaches the same outcome when it runs again", async () => {
    expect(await replayedOutcome(second)).toEqual(await replayedOutcome(first));
  });
});
