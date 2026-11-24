// PROTOTYPE (CDA-144), throwaway. Scene presets that jump to the states the hand-offs on CDA-144
// ask to see. Every scene pauses time; ::play or ::step moves the fake run on.
import { EMPTY_EDITOR } from "../src/editor.ts";
import { FOLLOWING } from "../src/viewport.ts";
import type { App } from "./app.tsx";
import { defaultSessions, type FakeCodingAgent } from "./host.ts";

function reset(app: App) {
  const { host, ui } = app;
  host.newSession();
  host.sessions = defaultSessions();
  host.gone.clear();
  host.editingId = undefined;
  host.run = undefined;
  host.paused = true;
  Object.assign(ui, {
    mode: "prompt",
    prompt: EMPTY_EDITOR,
    draft: undefined,
    edit: undefined,
    selected: undefined,
    confirm: undefined,
    notice: undefined,
    position: FOLLOWING,
  });
}

function q(host: FakeCodingAgent, text: string) {
  return { id: host.queuedId(), text };
}

function earlierRun(host: FakeCodingAgent) {
  host.openRun("add rate limiting to /api/login");
  for (let turn = 0; turn < 4; turn += 1) {
    host.step();
  }
}

function running(app: App) {
  const { host } = app;
  reset(app);
  earlierRun(host);
  host.openRun("use a sliding window instead of a fixed one");
  host.step();
  host.steers = [
    q(host, "reuse the existing redis client, not a new connection"),
    q(host, "keep the 429 message short"),
  ];
  host.followUps = [
    q(host, "add tests for the limiter, including the window edge"),
    q(host, "update the API section of the README"),
  ];
}

export const SCENES: Record<string, { about: string; apply(app: App): void }> = {
  empty: { about: "a new Session, nothing queued", apply: reset },
  running: {
    about: "a run is active with 2 Steers and 2 Follow-ups waiting",
    apply: running,
  },
  failed: {
    about: "the run failed: its left Steer became the head Follow-up, both wait",
    apply(app) {
      const { host } = app;
      reset(app);
      earlierRun(host);
      host.openRun("make the limit configurable per route");
      host.step();
      host.step();
      host.step();
      host.steers = [q(host, "read the limit from config/limits.ts")];
      host.followUps = [q(host, "add tests for the per-route limits")];
      host.transcript.push({ kind: "verification", id: "failed-v", status: "failed" });
      host.settle("failed");
    },
  },
  cancelled: {
    about: "Esc cancelled the run: the Steers became head Follow-ups, all wait",
    apply(app) {
      running(app);
      app.host.transcript.push({ kind: "notice", id: "cancel", text: "Cancellation requested" });
      app.host.cancel();
    },
  },
  editing: {
    about: "a run is active and the first Follow-up is being edited",
    apply(app) {
      running(app);
      const id = app.host.followUps[0]?.id;
      if (id !== undefined) {
        app.enterQueue(id);
        app.beginEdit(id);
      }
    },
  },
  headedit: {
    about: "the head Steer is in edit, so the run takes nothing (::step to see)",
    apply(app) {
      running(app);
      const id = app.host.steers[0]?.id;
      if (id !== undefined) {
        app.enterQueue(id);
        app.beginEdit(id);
      }
    },
  },
  sendnow: {
    about: "a Follow-up is selected: Enter sends it now, as a Steer at the tail",
    apply(app) {
      running(app);
      app.enterQueue(app.host.followUps[1]?.id);
      app.ui.notice = "Press Enter (Alt+Enter in C) to send the selected Follow-up now";
    },
  },
  idlesend: {
    about: "the run failed and a Follow-up is selected: send now opens a run",
    apply(app) {
      SCENES.failed?.apply(app);
      app.enterQueue(app.host.followUps[1]?.id);
      app.ui.notice = "Press Enter (Alt+Enter in C) to send it now: no run is active, so it starts";
    },
  },
  taken: {
    about: "the head Steer is selected; ::step lets the run take it from under you",
    apply(app) {
      running(app);
      app.enterQueue(app.host.steers[0]?.id);
      app.host.paused = false;
      app.ui.notice = "Time runs: the run takes the head Steer within 3 s. Act on it, or wait.";
    },
  },
  long: {
    about: "nine items queued, more than the strip shows",
    apply(app) {
      running(app);
      const { host } = app;
      host.steers.push(q(host, "and log the limiter decisions at debug level"));
      for (const text of [
        "add a metrics counter for rejected requests",
        "document the new env vars",
        "write a changelog entry",
        "check the Windows CI job",
        "open a draft PR",
      ]) {
        host.followUps.push(q(host, text));
      }
    },
  },
  picker: {
    about: "the resume list: current, held, cut-off, damaged and newer rows",
    apply(app) {
      reset(app);
      earlierRun(app.host);
      app.openPicker(1);
    },
  },
  race: {
    about: "the resume list on a row another terminal is about to open: press Enter",
    apply(app) {
      reset(app);
      earlierRun(app.host);
      app.openPicker(3);
      app.ui.notice = "Press Enter: another terminal takes this Session's lock first";
    },
  },
  pickerwait: {
    about: "Follow-ups wait, then Ctrl+R: resuming asks before it discards them",
    apply(app) {
      SCENES.failed?.apply(app);
      app.openPicker(6);
      app.ui.notice = "Press Enter: resuming discards the 2 waiting Follow-ups, so it asks first";
    },
  },
  startup: {
    about: "the notice at start when another Coding Agent holds a lock on this Repository Root",
    apply(app) {
      reset(app);
      app.host.transcript.push({
        kind: "notice",
        id: "lock",
        text: 'Another Coding Agent is running in ~/shop (PID 4242, Session "fix login redirect loop").',
      });
    },
  },
  worktree: {
    about: "the notice at start after --worktree limiter created a worktree",
    apply(app) {
      reset(app);
      app.host.transcript.push({
        kind: "notice",
        id: "worktree",
        text: [
          "Worktree limiter created in ~/.coding-agent/worktrees/shop-3f9a1c2b7d4e/limiter, branch coding-agent/limiter from main at 8eb6bb2.",
          "  The starting checkout has uncommitted changes; they stay there and are not in the worktree.",
          "  Copied from .worktreeinclude: .env, .env.local",
        ].join("\n"),
      });
    },
  },
};

export function applyScene(name: string, app: App) {
  const scene = SCENES[name];
  if (scene === undefined) {
    app.ui.notice = `No scene ${name}`;
    return;
  }
  scene.apply(app);
}

export const HELP = [
  "PROTOTYPE commands (type them in the Prompt and press Enter):",
  "  ::A ::B ::C   switch variant (or Tab / Shift+Tab)",
  "  ::win ::unix  Windows or macOS/Linux key table",
  "  ::play ::pause ::step   move the fake run (one Model Turn per step)",
  "  ::fail        the active run fails at its end",
  "  ::echo        key echo: what each chord arrives as in this terminal (Ctrl+C leaves)",
  "Scenes:",
  ...Object.entries(SCENES).map(([name, scene]) => `  ::${name.padEnd(11)} ${scene.about}`),
  "A task containing the word fail fails. Esc twice quits.",
].join("\n");
