import type { AgentSession, SessionEvent } from "@coding-agent/agent-core";
import { renderTui, type TuiHandle, type TuiHandlers, type TuiModel } from "@coding-agent/tui";
import { messageOf, redactorOf } from "./diagnostics.ts";
import type { ExitCode } from "./headless.ts";
import type { InteractiveArgs } from "./interactive-args.ts";
import { projectSessionEvent } from "./projection.ts";
import { resolveSessionSettings, SESSION_LIMITS_BY_PROFILE } from "./run-config.ts";
import {
  openSession as openRealSession,
  type SessionConfig,
  type SessionFactoryResult,
} from "./session-factory.ts";

// The interactive path (ADR 0004 §6): the Full-screen TUI wired to Agent Sessions, one at a time.
// It runs under the `ask` Approval Policy, writes no files, and runs the default Session Limits.

// A second cancel key within this time, with no Coding Task running, quits.
const QUIT_WINDOW_MS = 1_000;

export interface InteractiveOptions {
  readonly args: InteractiveArgs;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  // Diagnostics before the TUI starts. Once it owns the screen, everything goes to the transcript.
  readonly stderr: (text: string) => void;
  // Aborting it cancels the running Agent Session, waits for it to settle, and ends the run with
  // exit code 130.
  readonly signal: AbortSignal;
  // Whether standard input and output are both a terminal. The TUI cannot run on a pipe.
  readonly isTerminal: boolean;
  // Called once the TUI is up and a signal can cancel; before that, a signal ends the run at once.
  readonly onReady?: () => void;
  // Seams for tests: the TUI, the Agent Session factory and the clock of the quit window.
  readonly render?: (props: { model: TuiModel; handlers: TuiHandlers }) => TuiHandle;
  readonly openSession?: (config: SessionConfig) => Promise<SessionFactoryResult>;
  readonly now?: () => number;
  // How long a signal waits for a session that is still opening, which cannot be cancelled. A
  // session that is open settles within its own Cancellation Grace Period. Defaults to that period.
  readonly openGraceMs?: number;
}

// Resolves when `promise` does, or after `ms`, whichever comes first.
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise, expired]);
  clearTimeout(timer);
}

// Replaces the strings of `value` through `redact`, and returns `value` itself when none changed,
// so an event that carries no credential is projected as it came.
function redactStrings<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) {
    const items = value.map((item) => redactStrings(item, redact));
    return (items.every((item, index) => item === value[index]) ? value : items) as T;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]);
    const unchanged = entries.every(
      ([key, item]) => item === (value as Record<string, unknown>)[key as string],
    );
    return (unchanged ? value : Object.fromEntries(entries)) as T;
  }
  return value;
}

export async function runInteractive(options: InteractiveOptions): Promise<ExitCode> {
  const { stderr, signal } = options;
  const render = options.render ?? renderTui;
  const openSession = options.openSession ?? openRealSession;
  const now = options.now ?? Date.now;
  const openGraceMs = options.openGraceMs ?? SESSION_LIMITS_BY_PROFILE.default.cancellationGraceMs;

  // Configuration is resolved once, before the TUI takes the screen, so a refusal reads as a
  // plain error on the terminal and exits 2 without opening anything.
  const resolved = await resolveSessionSettings(options.args, options);
  if (!resolved.ok) {
    stderr(`coding-agent: ${resolved.message}\n`);
    return 2;
  }
  if (!options.isTerminal) {
    stderr(
      "coding-agent: the interactive path needs a terminal on standard input and output; " +
        "use `coding-agent run` for a task without one\n",
    );
    return 2;
  }
  if (signal.aborted) return 130;

  const settings = resolved.value;
  const redact = redactorOf(settings.credential);

  let model: TuiModel = { transcript: [] };
  let notices = 0;
  let busy = false;
  let closing = false;
  let cancelRequested = false;
  let quitPressedAt: number | undefined;
  let session: AgentSession | undefined;
  // Settles when the Coding Task that was submitted last has run to its end, or failed to start.
  let sessionLifecycle: Promise<void> = Promise.resolve();
  const { promise: exit, resolve: requestExit } = Promise.withResolvers<ExitCode>();

  // `model` is the whole state, so a draw that failed is repaired by the next one.
  function draw(): void {
    try {
      handle.update(model);
    } catch {}
  }

  function notify(text: string): void {
    model = {
      ...model,
      transcript: [
        ...model.transcript,
        { kind: "notice", id: `coding-agent/notice-${++notices}`, text: redact(text) },
      ],
    };
    draw();
  }

  // A failure here loses one event from the display and never reaches the Agent Session.
  function consume(event: SessionEvent): void {
    try {
      model = projectSessionEvent(redactStrings(event, redact), model);
    } catch (error) {
      notify(`Event ${event.sequence} (${event.type}) could not be shown: ${messageOf(error)}`);
      return;
    }
    draw();
  }

  // Reads a snapshot and follows the events after its last sequence, so nothing between the
  // snapshot and the subscription is lost (ADR 0002 §7).
  async function follow(active: AgentSession): Promise<void> {
    for await (const event of active.events(active.snapshot().lastSequence)) {
      consume(event);
    }
  }

  async function runTask(objective: string): Promise<void> {
    try {
      const opened = await openSession({
        ...settings,
        approvalPolicy: "ask",
        limits: SESSION_LIMITS_BY_PROFILE.default,
      });
      if (!opened.ok) {
        notify(`The Coding Task could not start: ${opened.message}`);
        return;
      }
      for (const { path, reason } of opened.skippedInstructions) {
        notify(`Project Instructions candidate ${path} skipped: ${reason}`);
      }
      const active = opened.session;
      session = active;
      // The subscription opens before the first command, so no event can be missed.
      const following = follow(active);
      // A cancel that came while the session was opening cancels it in place of starting it.
      const first = cancelRequested
        ? ({ type: "cancel" } as const)
        : ({ type: "start", task: { objective } } as const);
      const dispatched = await active.dispatch(first);
      if (!dispatched.accepted) {
        notify(`The Agent Session refused its first command: ${dispatched.message}`);
        await active.dispatch({ type: "cancel" });
      }
      await Promise.all([active.result(), following]);
    } catch (error) {
      notify(`Internal error: ${messageOf(error)}`);
    }
  }

  // An Agent Session is scoped to one Coding Task and has no prompt queue (ADR 0004 §6), so a
  // submission opens a session only when none is active, including one still opening.
  function submit(text: string): void {
    if (closing) return;
    if (busy) {
      notify(
        "A Coding Task is already running; press Esc or Ctrl+C to cancel it before submitting another.",
      );
      return;
    }
    busy = true;
    cancelRequested = false;
    sessionLifecycle = runTask(text).finally(() => {
      busy = false;
      session = undefined;
    });
  }

  function cancelTask(reason?: string): void {
    if (!busy) return;
    cancelRequested = true;
    const active = session;
    if (active === undefined) return;
    active
      .dispatch({ type: "cancel", ...(reason === undefined ? {} : { reason }) })
      .catch((error: unknown) => notify(`Cancel was not dispatched: ${messageOf(error)}`));
  }

  function decide(approvalId: string, decision: "allow" | "deny", reason?: string): void {
    const active = session;
    if (active === undefined) return;
    // The overlay is already closed. When the session did not take the decision, the host takes
    // the Approval out of the model so the person is not left looking at a stale one.
    const refused = (message: string) => {
      const { pendingApproval, ...rest } = model;
      if (pendingApproval?.approvalId === approvalId) {
        model = rest;
        draw();
      }
      notify(`The decision was not applied: ${message}`);
    };
    active
      .dispatch({
        type: "resolve_approval",
        approvalId,
        decision,
        ...(reason === undefined ? {} : { reason }),
      })
      .then(
        (result) => {
          if (!result.accepted) refused(result.message);
        },
        (error: unknown) => refused(messageOf(error)),
      );
  }

  // The TUI sends one signal for Esc and Ctrl+C. While a Coding Task runs it cancels; with none, a
  // second press within QUIT_WINDOW_MS quits, so one stray key never ends the run.
  function onCancel(): void {
    if (busy) {
      quitPressedAt = undefined;
      cancelTask();
      return;
    }
    const at = now();
    if (quitPressedAt !== undefined && at - quitPressedAt <= QUIT_WINDOW_MS) {
      closing = true;
      requestExit(0);
      return;
    }
    quitPressedAt = at;
    notify("Press Esc or Ctrl+C again within 1 second to quit.");
  }

  const handle = render({
    model,
    handlers: { onSubmit: submit, onCancel, onApproval: decide },
  });
  const onAbort = () => {
    closing = true;
    cancelTask(typeof signal.reason === "string" ? signal.reason : undefined);
    requestExit(130);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  options.onReady?.();
  // A listener never runs for an abort that came first.
  if (signal.aborted) onAbort();

  const code = await exit;
  signal.removeEventListener("abort", onAbort);
  // The Agent Session settles, and its outcome reaches the transcript, before the TUI goes. A
  // session that is still opening cannot be cancelled, so the wait for it is bounded: the run ends
  // once the grace has passed, and a session that opens after that is cancelled in place of started.
  await (session === undefined && busy ? within(sessionLifecycle, openGraceMs) : sessionLifecycle);
  await handle.unmount();
  return code;
}
