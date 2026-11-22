import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessLauncher } from "@coding-agent/tools";
import type { TuiModel } from "@coding-agent/tui";
import { createConfiguredChildLauncher } from "../src/child-launcher.ts";
import { type InteractiveOptions, runInteractive } from "../src/interactive.ts";
import type { SessionConfig } from "../src/session-factory.ts";
import { type FakeTui, fakeTui, waitFor } from "./support/fake-tui.ts";
import {
  NAMED_TASK_FILE,
  NAMED_TASK_REPO,
  NAMED_TASK_RUN,
  READ_ONLY_RUN,
} from "./support/named-task.ts";
import { replayInOrder, withProvider } from "./support/recorded-provider.ts";
import { scriptedAgent } from "./support/scripted-agent.ts";

const secret = "sk-test-credential-value";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await realpath(await mkdtemp(join(tmpdir(), "coding-agent-interactive-")));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const notices = (model: TuiModel) =>
  model.transcript.flatMap((entry) => (entry.kind === "notice" ? [entry.text] : []));
const outcomes = (model: TuiModel) =>
  model.transcript.flatMap((entry) => (entry.kind === "outcome" ? [entry.status] : []));
const toolCalls = (model: TuiModel) =>
  model.transcript.flatMap((entry) => (entry.kind === "tool_call" ? [entry.status] : []));
const tasks = (model: TuiModel) =>
  model.transcript.flatMap((entry) => (entry.kind === "user" ? [entry.text] : []));

interface Setup {
  readonly tui?: FakeTui;
  // Left out, the scripted agent opens the sessions; `undefined` leaves them to the real factory.
  readonly openSession?: InteractiveOptions["openSession"];
  readonly isTerminal?: boolean;
  readonly now?: () => number;
  readonly env?: Record<string, string>;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly repoRoot?: string;
  readonly openGraceMs?: number;
  readonly launcher?: ChildProcessLauncher;
}

// A scripted session starts no child, so it needs no launcher.
const noLauncher = {} as ChildProcessLauncher;

function realLauncher(): ChildProcessLauncher {
  const created = createConfiguredChildLauncher();
  if (!created.ok) throw new Error(created.message);
  return created.launcher;
}

function start(setup: Setup = {}) {
  const tui = setup.tui ?? fakeTui();
  const stderr: string[] = [];
  const controller = new AbortController();
  const exited = runInteractive({
    args: {
      provider: "google",
      model: setup.model ?? READ_ONLY_RUN.model,
      repoRoot: setup.repoRoot ?? repoRoot,
      approvalPolicy: "ask",
    },
    cwd: repoRoot,
    env: setup.env ?? { GOOGLE_API_KEY: secret },
    stderr: (text) => stderr.push(text),
    signal: setup.signal ?? controller.signal,
    isTerminal: setup.isTerminal ?? true,
    launcher: setup.launcher ?? noLauncher,
    render: tui.render,
    ...("openSession" in setup
      ? { openSession: setup.openSession }
      : { openSession: scriptedAgent() }),
    ...(setup.now === undefined ? {} : { now: setup.now }),
    ...(setup.openGraceMs === undefined ? {} : { openGraceMs: setup.openGraceMs }),
  });
  return { tui, stderr, controller, exited };
}

const awaitApproval = (tui: FakeTui) =>
  waitFor(() => tui.latest().pendingApproval !== undefined, "an Approval to be requested");

const awaitOutcomes = (tui: FakeTui, count: number) =>
  waitFor(() => outcomes(tui.latest()).length >= count, `${count} settled Agent Session(s)`);

const pendingId = (tui: FakeTui) => tui.latest().pendingApproval?.approvalId ?? "";

// Ends a run whose Coding Task has settled.
async function finish(run: ReturnType<typeof start>): Promise<void> {
  run.controller.abort();
  await run.exited;
}

describe("starting a Coding Task", () => {
  it("opens one Agent Session under the ask policy and streams it into the transcript", async () => {
    const configs: SessionConfig[] = [];
    const run = start({ openSession: scriptedAgent({ configs }) });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);
    expect(run.tui.latest().pendingApproval?.summary).toBe("Run bun test");
    run.tui.handlers().onApproval(pendingId(run.tui), "allow");
    await awaitOutcomes(run.tui, 1);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.approvalPolicy).toBe("ask");
    expect(configs[0]?.limits.maxModelTurns).toBe(30);
    const model = run.tui.latest();
    expect(tasks(model)).toEqual(["Make the tests pass"]);
    expect(
      model.transcript.some(
        (entry) => entry.kind === "assistant" && entry.text === "All tests pass.",
      ),
    ).toBe(true);
    expect(outcomes(model)).toEqual(["succeeded"]);
    await finish(run);
  });

  it("subscribes after the snapshot's last sequence before it dispatches start", async () => {
    const calls: string[] = [];
    const run = start({ openSession: scriptedAgent({ calls }) });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    expect(calls.slice(0, 2)).toEqual(["events(0)", "dispatch:start"]);
    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 1);
    await finish(run);
  });

  it("can start another Coding Task once the first has settled", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onSubmit("first");
    await awaitApproval(run.tui);
    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 1);
    run.tui.handlers().onSubmit("second");
    await waitFor(() => tasks(run.tui.latest()).length === 2, "the second Coding Task");

    expect(tasks(run.tui.latest())).toEqual(["first", "second"]);
    // The only notice is the first session's own cancellation, not a refusal.
    expect(notices(run.tui.latest())).toEqual(["cancellation requested"]);
    await awaitApproval(run.tui);
    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 2);
    await finish(run);
  });

  it("shows why a Coding Task could not start and accepts the next one", async () => {
    const working = scriptedAgent();
    let attempts = 0;
    const run = start({
      openSession: async (config) =>
        ++attempts === 1
          ? { ok: false, code: "INVALID_CONFIGURATION", message: "the repository is gone" }
          : working(config),
    });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onSubmit("first");
    await waitFor(() => notices(run.tui.latest()).length === 1, "a notice");
    expect(notices(run.tui.latest())[0]).toBe(
      "The Coding Task could not start: the repository is gone",
    );
    run.tui.handlers().onSubmit("second");
    await awaitApproval(run.tui);

    expect(tasks(run.tui.latest())).toEqual(["second"]);
    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 1);
    await finish(run);
  });
});

describe("a submission while a session is active", () => {
  it("is refused with a notice, and no second Agent Session opens", async () => {
    const configs: SessionConfig[] = [];
    const run = start({ openSession: scriptedAgent({ configs }) });
    await waitFor(() => run.tui.mounted(), "the TUI");

    // The second arrives before the first session has opened.
    run.tui.handlers().onSubmit("first");
    run.tui.handlers().onSubmit("second");
    await awaitApproval(run.tui);
    run.tui.handlers().onSubmit("third");

    expect(configs).toHaveLength(1);
    expect(notices(run.tui.latest())).toHaveLength(2);
    expect(notices(run.tui.latest())[0]).toContain("already running");
    expect(tasks(run.tui.latest())).toEqual(["first"]);
    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 1);
    await finish(run);
  });
});

describe("deciding an Approval", () => {
  it("allows the Tool Call, and the transcript shows its outcome", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.tui.handlers().onApproval(pendingId(run.tui), "allow");
    await awaitOutcomes(run.tui, 1);

    expect(toolCalls(run.tui.latest())).toEqual(["succeeded"]);
    expect(run.tui.latest().pendingApproval).toBeUndefined();
    await finish(run);
  });

  it("denies the Tool Call with the reason, and the transcript shows it denied", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.tui.handlers().onApproval(pendingId(run.tui), "deny", "not on my machine");
    await awaitOutcomes(run.tui, 1);

    expect(toolCalls(run.tui.latest())).toEqual(["denied"]);
    expect(run.tui.latest().pendingApproval).toBeUndefined();
    await finish(run);
  });

  it("says so when the session did not take a decision, and keeps the Approval that is pending", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);
    const pending = pendingId(run.tui);

    run.tui.handlers().onApproval("not-the-approval", "allow");
    await waitFor(() => notices(run.tui.latest()).length === 1, "a notice");

    expect(notices(run.tui.latest())[0]).toStartWith("The decision was not applied:");
    expect(run.tui.latest().pendingApproval?.approvalId).toBe(pending);
    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 1);
    await finish(run);
  });
});

describe("cancelling", () => {
  it("cancels the running session with the cancel key and keeps the TUI up", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.tui.handlers().onCancel();
    await awaitOutcomes(run.tui, 1);

    expect(outcomes(run.tui.latest())).toEqual(["cancelled"]);
    expect(run.tui.latest().pendingApproval).toBeUndefined();
    expect(run.tui.unmountedWith()).toBeUndefined();
    await finish(run);
  });

  it("cancels on a signal, waits for the session to settle, and only then unmounts", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.controller.abort("SIGINT");

    expect(await run.exited).toBe(130);
    const atUnmount = run.tui.unmountedWith();
    expect(atUnmount && outcomes(atUnmount)).toEqual(["cancelled"]);
  });

  it("ends the run with 130 on a signal while no Coding Task runs", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.controller.abort("SIGTERM");

    expect(await run.exited).toBe(130);
    expect(run.tui.unmountedWith()).toBeDefined();
  });

  it("cancels in place of starting when the signal comes while the session opens", async () => {
    const calls: string[] = [];
    const opening = scriptedAgent({ calls });
    const run = start({
      openSession: async (config) => {
        run.controller.abort("SIGINT");
        return opening(config);
      },
    });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onSubmit("Make the tests pass");

    expect(await run.exited).toBe(130);
    // The reason of the signal reaches the cancel that stands in for the start.
    expect(calls).toEqual(["events(0)", "dispatch:cancel:SIGINT"]);
    const atUnmount = run.tui.unmountedWith();
    expect(atUnmount && outcomes(atUnmount)).toEqual(["cancelled"]);
  });

  it("ends the run on a signal even when the session never finishes opening", async () => {
    let opened = 0;
    const run = start({
      // An open that never returns, and has no way to be cancelled.
      openSession: () => {
        opened++;
        return new Promise(() => undefined);
      },
      openGraceMs: 30,
    });
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await waitFor(() => opened === 1, "the session to start opening");

    run.controller.abort("SIGINT");

    expect(await run.exited).toBe(130);
    const atUnmount = run.tui.unmountedWith();
    expect(atUnmount && outcomes(atUnmount)).toEqual([]);
  });

  it("refuses a submission while the run waits for the session to settle", async () => {
    const run = start();
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.controller.abort("SIGINT");
    run.tui.handlers().onSubmit("another");

    expect(await run.exited).toBe(130);
    const atUnmount = run.tui.unmountedWith();
    expect(atUnmount && notices(atUnmount)).toContain(
      "Coding Agent is stopping; this Coding Task was not started.",
    );
    expect(atUnmount && tasks(atUnmount)).toEqual(["Make the tests pass"]);
  });

  it("ends the run without a TUI when the signal came before it started", async () => {
    const tui = fakeTui();
    const controller = new AbortController();
    controller.abort("SIGINT");

    const run = start({ tui, signal: controller.signal });

    expect(await run.exited).toBe(130);
    expect(tui.mounted()).toBe(false);
  });
});

describe("quitting", () => {
  it("quits on a second cancel key within a second, when no Coding Task runs", async () => {
    let time = 10_000;
    const run = start({ now: () => time });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onCancel();
    expect(notices(run.tui.latest())).toEqual([
      "Press Esc or Ctrl+C again within 1 second to quit.",
    ]);
    expect(await Promise.race([run.exited, Bun.sleep(20).then(() => "running")])).toBe("running");
    time += 600;
    run.tui.handlers().onCancel();

    expect(await run.exited).toBe(0);
    expect(run.tui.unmountedWith()).toBeDefined();
  });

  it("does not quit on a second cancel key after more than a second", async () => {
    let time = 10_000;
    const run = start({ now: () => time });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onCancel();
    time += 1_500;
    run.tui.handlers().onCancel();

    expect(await Promise.race([run.exited, Bun.sleep(20).then(() => "running")])).toBe("running");
    expect(notices(run.tui.latest())).toHaveLength(2);
    await finish(run);
  });
});

describe("a consumer error", () => {
  it("never fails the Coding Task: a draw that throws is repaired by the next one", async () => {
    const tui = fakeTui((_model, count) => {
      if (count % 2 === 0) throw new Error("the terminal went away");
    });
    const run = start({ tui });
    await waitFor(() => tui.mounted(), "the TUI");
    tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(tui);

    tui.handlers().onApproval(pendingId(tui), "allow");
    await awaitOutcomes(tui, 1);

    expect(outcomes(tui.latest())).toEqual(["succeeded"]);
    await finish(run);
  });

  it("loses only the event that could not be shown", async () => {
    const opening = scriptedAgent();
    const run = start({
      openSession: async (config) => {
        const opened = await opening(config);
        if (!opened.ok) return opened;
        const { session } = opened;
        return {
          ...opened,
          session: {
            ...session,
            async *events(after) {
              for await (const event of session.events(after)) {
                // One event the projection cannot read.
                yield event.type === "assistant_message_started"
                  ? ({ ...event, data: undefined } as unknown as typeof event)
                  : event;
              }
            },
          },
        };
      },
    });
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.tui.handlers().onApproval(pendingId(run.tui), "allow");
    await awaitOutcomes(run.tui, 1);

    expect(notices(run.tui.latest())[0]).toContain("could not be shown");
    expect(outcomes(run.tui.latest())).toEqual(["succeeded"]);
    await finish(run);
  });

  it("keeps the session counted as running when the display can no longer follow it", async () => {
    const configs: SessionConfig[] = [];
    const opening = scriptedAgent({ configs });
    const run = start({
      openSession: async (config) => {
        const opened = await opening(config);
        if (!opened.ok) return opened;
        // An event stream that fails at once, which Agent Core itself never does.
        const events = () => {
          throw new Error("the stream broke");
        };
        return { ...opened, session: { ...opened.session, events } };
      },
    });
    await waitFor(() => run.tui.mounted(), "the TUI");

    run.tui.handlers().onSubmit("first");
    await waitFor(
      () => notices(run.tui.latest()).some((text) => text.includes("event stream failed")),
      "the notice that the stream failed",
    );
    // The session was not settled by the failure, so a second Coding Task is still refused.
    run.tui.handlers().onSubmit("second");
    await waitFor(
      () => notices(run.tui.latest()).some((text) => text.includes("already running")),
      "the refusal of a second Coding Task",
    );
    expect(configs).toHaveLength(1);

    // Once the session settles, the next Coding Task opens a session of its own.
    run.tui.handlers().onCancel();
    await waitFor(() => {
      run.tui.handlers().onSubmit("third");
      return configs.length === 2;
    }, "the session to settle");
    await finish(run);
  });
});

describe("the credential", () => {
  it("is replaced by [redacted] in everything the transcript shows", async () => {
    const run = start({ openSession: scriptedAgent({ answer: `The key is ${secret}.` }) });
    await waitFor(() => run.tui.mounted(), "the TUI");
    run.tui.handlers().onSubmit("Make the tests pass");
    await awaitApproval(run.tui);

    run.tui.handlers().onApproval(pendingId(run.tui), "allow");
    await awaitOutcomes(run.tui, 1);

    const shown = JSON.stringify(run.tui.latest());
    expect(shown).not.toContain(secret);
    expect(shown).toContain("The key is [redacted].");
    await finish(run);
  });
});

describe("refusing to start", () => {
  it("exits 2 on a configuration error without taking the screen", async () => {
    const run = start({ model: "no-such-model" });

    expect(await run.exited).toBe(2);
    expect(run.stderr.join("")).toBe(
      'coding-agent: --model "no-such-model" is not a known google model\n',
    );
    expect(run.tui.mounted()).toBe(false);
  });

  it("exits 2 when the provider credential is missing", async () => {
    const run = start({ env: {} });

    expect(await run.exited).toBe(2);
    expect(run.stderr.join("")).toContain("no credential for --provider google");
    expect(run.tui.mounted()).toBe(false);
  });

  it("exits 2 when standard input or output is not a terminal", async () => {
    const run = start({ isTerminal: false });

    expect(await run.exited).toBe(2);
    expect(run.stderr.join("")).toContain("needs a terminal");
    expect(run.stderr.join("")).toContain("coding-agent run");
    expect(run.tui.mounted()).toBe(false);
  });
});

describe("with the real session factory and a recorded provider", () => {
  it("runs the named task from the Prompt to a succeeded outcome", async () => {
    const repo = join(repoRoot, "repo");
    await cp(NAMED_TASK_REPO, repo, { recursive: true });
    const objective = await Bun.file(NAMED_TASK_FILE).text();

    await withProvider(replayInOrder(READ_ONLY_RUN.fixtures), async () => {
      const run = start({ openSession: undefined, repoRoot: repo, launcher: realLauncher() });
      await waitFor(() => run.tui.mounted(), "the TUI");

      run.tui.handlers().onSubmit(objective);
      await awaitOutcomes(run.tui, 1);

      expect(outcomes(run.tui.latest())).toEqual(["succeeded"]);
      expect(toolCalls(run.tui.latest()).length).toBeGreaterThan(0);
      await finish(run);
    });
  });
});

describe("with the four tools and the Verification Policy of a real session", () => {
  it("asks for an Approval before each change and finishes the named task once they are allowed", async () => {
    const repo = join(repoRoot, "repo");
    await cp(NAMED_TASK_REPO, repo, { recursive: true });
    const objective = await Bun.file(NAMED_TASK_FILE).text();

    await withProvider(replayInOrder(NAMED_TASK_RUN.fixtures), async () => {
      const run = start({
        openSession: undefined,
        repoRoot: repo,
        launcher: realLauncher(),
        env: {
          GOOGLE_API_KEY: secret,
          CODING_AGENT_VERIFICATION_COMMAND: NAMED_TASK_RUN.verificationCommand,
        },
      });
      await waitFor(() => run.tui.mounted(), "the TUI");
      run.tui.handlers().onSubmit(objective);

      // Each Approval is allowed once, as the person would from the overlay.
      const allowed: string[] = [];
      await waitFor(
        () => {
          const pending = run.tui.latest().pendingApproval;
          if (pending !== undefined && !allowed.includes(pending.approvalId)) {
            allowed.push(pending.approvalId);
            run.tui.handlers().onApproval(pending.approvalId, "allow");
          }
          return outcomes(run.tui.latest()).length >= 1;
        },
        "the named task to settle",
        45_000,
      );

      const model = run.tui.latest();
      const tools = model.transcript.flatMap((entry) =>
        entry.kind === "tool_call" ? [entry.toolName] : [],
      );
      expect(outcomes(model)).toEqual(["succeeded"]);
      expect(allowed.length).toBeGreaterThan(0);
      expect(tools.some((name) => name === "write" || name === "edit")).toBe(true);
      expect(toolCalls(model)).not.toContain("denied");
      await finish(run);
    });
  }, 60_000);
});
