import type { AgentResult } from "@coding-agent/agent-core";
import { BUILD_INFO } from "./build-info.ts";
import type { RunArgs } from "./run-args.ts";
import { type RunConfig, removeCreated, resolveRunConfig } from "./run-config.ts";
import { openRunFiles, type RunFiles, type RunRecord } from "./run-files.ts";
import { openSession } from "./session-factory.ts";

export type ExitCode = 0 | 1 | 2 | 70 | 130;

export interface HeadlessOptions {
  readonly args: RunArgs;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  // Aborting it dispatches `cancel`; a string abort reason becomes the cancellation reason.
  readonly signal: AbortSignal;
  // Called once the Agent Session can take `cancel`.
  readonly onSessionOpened?: () => void;
}

export interface HeadlessResult {
  readonly exitCode: ExitCode;
  // Absent when no Agent Session settled.
  readonly result?: AgentResult;
}

const EXIT_CODE_BY_OUTCOME = {
  succeeded: 0,
  failed: 1,
  cancelled: 130,
} as const satisfies Record<AgentResult["outcome"], ExitCode>;

// A setting that is valid but not built yet is not the caller's error, so it exits 70, not 2.
const EXIT_CODE_BY_REFUSAL = {
  INVALID_CONFIGURATION: 2,
  NOT_IMPLEMENTED: 70,
} as const satisfies Record<"INVALID_CONFIGURATION" | "NOT_IMPLEMENTED", ExitCode>;

interface Refusal {
  readonly code: keyof typeof EXIT_CODE_BY_REFUSAL;
  readonly message: string;
}

const diagnostic = (message: string): string => `coding-agent: ${message}\n`;
const internalError = (message: string): string => diagnostic(`internal error: ${message}`);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function failureOf(task: Promise<void>): Promise<string | undefined> {
  return task.then(
    () => undefined,
    (error: unknown) => messageOf(error),
  );
}

function refuse({ code, message }: Refusal, stderr: (text: string) => void): HeadlessResult {
  stderr(diagnostic(message));
  return { exitCode: EXIT_CODE_BY_REFUSAL[code] };
}

function finalText({ finalMessage }: AgentResult): string {
  return (finalMessage?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function describeOutcome(result: AgentResult): string {
  const changed = result.workspaceChanged ? "yes" : "no";
  const outcome = diagnostic(`${result.outcome}; workspace changed: ${changed}`);
  if (result.outcome !== "failed") return outcome;
  return outcome + diagnostic(`${result.failure.code}: ${result.failure.message}`);
}

// The two streams are diagnostic only (ADR 0005 §3): a failed write must not change the exit code.
function printer(write: (text: string) => void, redact: (text: string) => string) {
  return (text: string): void => {
    try {
      write(redact(text));
    } catch {}
  };
}

function runRecord(
  config: RunConfig,
  { systemPrompt, toolNames }: { systemPrompt: string; toolNames: readonly string[] },
): RunRecord {
  return {
    codingAgent: BUILD_INFO,
    provider: config.model.provider,
    model: config.model.id,
    sampling: config.sampling,
    transportRetryBound: config.transportRetryBound,
    repoRoot: config.repoRoot,
    profile: config.profile,
    limits: config.limits,
    approvalPolicy: config.approvalPolicy,
    verification: config.verification,
    tools: toolNames,
    systemPrompt,
  };
}

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const resolved = await resolveRunConfig(options.args, options);
  if (!resolved.ok)
    return refuse(
      resolved,
      printer(options.stderr, (text) => text),
    );
  const { config, createdDirectories } = resolved;
  // A provider error or a file the model read can carry the credential into the text printed here.
  const redact = (text: string) => text.replaceAll(config.credential.reveal(), "[redacted]");
  const stdout = printer(options.stdout, redact);
  const stderr = printer(options.stderr, redact);

  let running = false;
  let files: RunFiles | undefined;
  let stopListening = (): void => undefined;
  try {
    const opened = await openSession(config);
    if (!opened.ok) {
      await removeCreated(createdDirectories);
      return refuse(opened, stderr);
    }
    const { session, skippedInstructions } = opened;
    for (const { path, reason } of skippedInstructions) {
      stderr(diagnostic(`Project Instructions candidate ${path} skipped: ${reason}`));
    }

    files = await openRunFiles(config.outputDir, runRecord(config, opened), redact);
    // Never awaited by the Agent Session, so a failed write surfaces only once it has settled.
    const logged = failureOf(files.logEvents(session.events()));

    const cancel = () => {
      const { reason } = options.signal;
      return session.dispatch({
        type: "cancel",
        ...(typeof reason === "string" ? { reason } : {}),
      });
    };
    const onAbort = () => {
      cancel().catch((error: unknown) =>
        stderr(internalError(`cancel was not dispatched: ${messageOf(error)}`)),
      );
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    stopListening = () => options.signal.removeEventListener("abort", onAbort);
    options.onSessionOpened?.();

    // A listener never runs for an abort that came first, so that abort cancels in place of `start`.
    const task = { objective: config.objective };
    const dispatched = await (options.signal.aborted
      ? cancel()
      : session.dispatch({ type: "start", task }));
    if (!dispatched.accepted)
      throw new Error(`the Agent Session refused its first command: ${dispatched.message}`);
    running = true;

    const result = await session.result();
    const finishedAt = new Date().toISOString();
    const logFailure = await logged;
    const exitCode: ExitCode = logFailure === undefined ? EXIT_CODE_BY_OUTCOME[result.outcome] : 70;
    const resultFailure = await failureOf(files.writeResult({ exitCode, result, finishedAt }));

    const text = finalText(result);
    if (text !== "") stdout(text.endsWith("\n") ? text : `${text}\n`);
    stderr(describeOutcome(result));
    if (logFailure !== undefined)
      stderr(internalError(`events.jsonl is incomplete: ${logFailure}`));
    if (resultFailure !== undefined) {
      stderr(internalError(`result.json was not written: ${resultFailure}`));
      return { exitCode: 70, result };
    }
    return { exitCode, result };
  } catch (error) {
    if (!running) {
      await files?.discard();
      files = undefined;
      await removeCreated(createdDirectories);
    }
    stderr(internalError(messageOf(error)));
    return { exitCode: 70 };
  } finally {
    stopListening();
    await files?.close().catch(() => undefined);
  }
}
