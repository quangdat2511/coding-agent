// PROTOTYPE (CDA-144), throwaway. A fake Coding Agent Session that follows CDA-140's Prompt Queue
// rules closely enough to react to the TUI: no model, no files, scripted Model Turns on a timer.
import type { TranscriptEntry } from "../src/types.ts";

export const TURN_MS = 2500;

export interface QueueItem {
  readonly id: string;
  readonly text: string;
}

export type QueueKind = "steer" | "followUp";
export type Outcome = "succeeded" | "failed" | "cancelled";

export interface SessionRow {
  readonly id: string;
  name: string;
  readonly lastActivity: string;
  tasks: number | undefined;
  current?: boolean;
  held?: { readonly pid: number };
  readonly cutOff?: boolean;
  readonly damaged?: boolean;
  readonly newer?: boolean;
  readonly losesRace?: boolean;
  readonly preview: readonly string[];
}

interface Run {
  readonly id: string;
  readonly task: string;
  turn: number;
  readonly turns: number;
  fails: boolean;
}

export const REPO = "~/shop";

export class FakeCodingAgent {
  transcript: TranscriptEntry[] = [];
  steers: QueueItem[] = [];
  followUps: QueueItem[] = [];
  editingId: string | undefined;
  run: Run | undefined;
  lastOutcome: Outcome | undefined;
  sessions: SessionRow[] = defaultSessions();
  sessionName = "(new Session)";
  paused = false;
  // Ids that left the queue, so an action on them gets CDA-140 §7's notice.
  readonly gone = new Map<string, "taken" | "started">();
  #seq = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #changed: (notice?: string) => void;

  constructor(changed: (notice?: string) => void) {
    this.#changed = changed;
  }

  start(): void {
    this.#timer = setInterval(() => {
      if (!this.paused && this.run !== undefined) {
        this.step();
        this.#changed();
      }
    }, TURN_MS);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  #id(kind: string): string {
    this.#seq += 1;
    return `${kind}-${this.#seq}`;
  }

  queuedId(): string {
    this.#seq += 1;
    return `queued-${this.#seq.toString(16).padStart(4, "0")}`;
  }

  items(): { kind: QueueKind; item: QueueItem }[] {
    return [
      ...this.steers.map((item) => ({ kind: "steer" as const, item })),
      ...this.followUps.map((item) => ({ kind: "followUp" as const, item })),
    ];
  }

  find(id: string): { kind: QueueKind; item: QueueItem } | undefined {
    return this.items().find((entry) => entry.item.id === id);
  }

  // Why Follow-ups wait while no run is active (CDA-140 §2), or undefined when they do not.
  waitingReason(): string | undefined {
    if (this.run !== undefined || this.followUps.length === 0) {
      return undefined;
    }
    if (this.followUps[0]?.id === this.editingId) {
      return "the first one is being edited";
    }
    switch (this.lastOutcome) {
      case "failed":
        return "the last run failed";
      case "cancelled":
        return "the last run was cancelled";
      default:
        return "no run has succeeded yet";
    }
  }

  submit(raw: string, how: "enter" | "followUp"): string | undefined {
    const text = raw.trim();
    if (text === "") {
      return undefined;
    }
    if (this.run === undefined) {
      this.paused = false;
      this.openRun(text);
      return undefined;
    }
    const item = { id: this.queuedId(), text };
    if (how === "enter") {
      this.steers.push(item);
      return undefined;
    }
    this.followUps.push(item);
    return undefined;
  }

  openRun(task: string): void {
    if (this.sessionName === "(new Session)") {
      this.sessionName = task.split("\n")[0] ?? task;
      const named = this.sessions.find((row) => row.current);
      if (named !== undefined) {
        named.name = this.sessionName;
      }
    }
    const current = this.sessions.find((row) => row.current);
    if (current !== undefined && current.tasks !== undefined) {
      current.tasks += 1;
    }
    this.run = { id: this.#id("run"), task, turn: 0, turns: 4, fails: /\bfail/i.test(task) };
    this.transcript.push({ kind: "user", id: this.#id("user"), text: task });
  }

  // One Model Turn: take at most one Steer first (CDA-139), then a scripted turn.
  step(): void {
    const run = this.run;
    if (run === undefined) {
      return;
    }
    run.turn += 1;
    const head = this.steers[0];
    if (head !== undefined && head.id !== this.editingId) {
      this.steers.shift();
      this.gone.set(head.id, "taken");
      this.transcript.push({
        kind: "notice",
        id: this.#id("notice"),
        text: `Steer taken before Model Turn ${run.turn}`,
      });
      this.transcript.push({ kind: "user", id: this.#id("user"), text: head.text });
    }
    const script = TURNS[(run.turn - 1) % TURNS.length];
    if (script !== undefined) {
      this.transcript.push(...script(this.#id("turn"), run.fails && run.turn >= run.turns));
    }
    if (run.turn >= run.turns) {
      this.settle(run.fails ? "failed" : "succeeded");
    }
  }

  settle(outcome: Outcome): void {
    this.transcript.push({
      kind: "outcome",
      id: this.#id("outcome"),
      status: outcome,
      failure:
        outcome === "failed"
          ? { code: "VERIFICATION_FAILED", message: "bun test: 1 failing test" }
          : undefined,
      workspaceChanged: true,
      partialChangesPossible: outcome !== "succeeded",
    });
    this.run = undefined;
    this.lastOutcome = outcome;
    // CDA-140 §3: Steers left at settlement become head Follow-ups, keeping ids and order.
    this.followUps = [...this.steers, ...this.followUps];
    this.steers = [];
    if (outcome === "succeeded") {
      this.startHeadFollowUp();
    }
  }

  startHeadFollowUp(): void {
    const head = this.followUps[0];
    if (head !== undefined && head.id !== this.editingId) {
      this.followUps.shift();
      this.gone.set(head.id, "started");
      this.openRun(head.text);
    }
  }

  cancel(): boolean {
    if (this.run === undefined) {
      return false;
    }
    this.settle("cancelled");
    return true;
  }

  #goneNotice(id: string): string {
    return this.gone.get(id) === "started" ? "Already started" : "Already taken";
  }

  // CDA-140 §5.
  sendNow(id: string): string {
    const found = this.find(id);
    if (found === undefined) {
      return this.#goneNotice(id);
    }
    if (found.kind === "steer") {
      return "Send now is for Follow-ups: this Steer already goes before the next Model Turn";
    }
    this.followUps = this.followUps.filter((item) => item.id !== id);
    if (this.editingId === id) {
      this.editingId = undefined;
    }
    if (this.run !== undefined) {
      this.steers.push(found.item);
      return `Sent now: a Steer after ${this.steers.length - 1} earlier Steer(s)`;
    }
    this.gone.set(id, "started");
    this.openRun(found.item.text);
    return "Sent now: started a run";
  }

  beginEdit(id: string): string | undefined {
    if (this.find(id) === undefined) {
      return this.#goneNotice(id);
    }
    this.editingId = id;
    return undefined;
  }

  saveEdit(id: string, raw: string): string | undefined {
    const text = raw.trim();
    if (text === "") {
      return "Empty text is not saved: delete the item instead";
    }
    const replace = (item: QueueItem) => (item.id === id ? { id, text } : item);
    this.steers = this.steers.map(replace);
    this.followUps = this.followUps.map(replace);
    this.endEdit();
    return undefined;
  }

  endEdit(): void {
    this.editingId = undefined;
    if (this.run === undefined && this.lastOutcome === "succeeded") {
      this.startHeadFollowUp();
    }
  }

  remove(id: string): string {
    const found = this.find(id);
    if (found === undefined) {
      return this.#goneNotice(id);
    }
    this.steers = this.steers.filter((item) => item.id !== id);
    this.followUps = this.followUps.filter((item) => item.id !== id);
    if (this.editingId === id) {
      this.editingId = undefined;
    }
    return found.kind === "steer" ? "Steer deleted" : "Follow-up deleted";
  }

  // queue.dequeue: every item back into the Prompt (Pi's Alt+Up).
  dequeueAll(): string[] {
    const texts = this.items().map((entry) => entry.item.text);
    this.steers = [];
    this.followUps = [];
    this.editingId = undefined;
    return texts;
  }

  newSession(): void {
    this.transcript = [];
    this.followUps = [];
    this.steers = [];
    this.lastOutcome = undefined;
    this.sessionName = "(new Session)";
  }

  resume(row: SessionRow): void {
    for (const session of this.sessions) {
      session.current = session.id === row.id;
    }
    this.transcript = row.preview.map((text, index) => ({
      kind: "notice" as const,
      id: `resumed-${row.id}-${index}`,
      text,
    }));
    this.followUps = [];
    this.steers = [];
    this.lastOutcome = undefined;
    this.sessionName = row.name;
  }
}

type TurnScript = (id: string, failing: boolean) => TranscriptEntry[];

const TURNS: readonly TurnScript[] = [
  (id) => [
    { kind: "assistant", id: `${id}-a`, text: "Reading the handler first.", status: "completed" },
    {
      kind: "tool_call",
      id: `${id}-t`,
      toolName: "read",
      summary: "src/api/login.ts",
      status: "succeeded",
      result: { content: "export async function login(req: Request) {", isError: false },
    },
  ],
  (id) => [
    {
      kind: "tool_call",
      id: `${id}-t`,
      toolName: "edit",
      summary: "src/api/login.ts (+12 -2)",
      status: "succeeded",
      result: { content: "applied 1 edit", isError: false },
    },
  ],
  (id) => [
    {
      kind: "tool_call",
      id: `${id}-t`,
      toolName: "bash",
      summary: "bun test",
      status: "succeeded",
      result: { content: "14 pass, 0 fail", isError: false },
    },
  ],
  (id, failing) => [
    { kind: "verification", id: `${id}-v`, status: failing ? "failed" : "succeeded" },
    {
      kind: "assistant",
      id: `${id}-a`,
      text: failing ? "The test still fails; stopping here." : "Done.",
      status: "completed",
    },
  ],
];

export function defaultSessions(): SessionRow[] {
  return [
    {
      id: "s-current",
      name: "(new Session)",
      lastActivity: "now",
      tasks: 0,
      current: true,
      preview: [],
    },
    {
      id: "s-held",
      name: "fix login redirect loop",
      lastActivity: "12 min ago",
      tasks: 6,
      held: { pid: 4242 },
      preview: ["> fix the login redirect loop", "assistant [completed]", "  Redirect fixed."],
    },
    {
      id: "s-cut",
      name: "migrate session store to redis",
      lastActivity: "yesterday 18:40",
      tasks: 14,
      cutOff: true,
      preview: ["> move sessions to redis", "bash bun test [cancelled]", "run [interrupted]"],
    },
    {
      id: "s-race",
      name: "Sửa test đang lỗi trong src/math.ts",
      lastActivity: "3 days ago",
      tasks: 1,
      losesRace: true,
      preview: ["> Sửa test đang lỗi trong src/math.ts", "session [succeeded]"],
    },
    {
      id: "s-damaged",
      name: "bump bun to 1.3",
      lastActivity: "5 days ago",
      tasks: undefined,
      damaged: true,
      preview: [],
    },
    {
      id: "s-newer",
      name: "explore a new parser",
      lastActivity: "2 weeks ago",
      tasks: 2,
      newer: true,
      preview: [],
    },
    {
      id: "s-old",
      name: "add a /health endpoint",
      lastActivity: "3 weeks ago",
      tasks: 9,
      preview: ["> add a /health endpoint for the load balancer", "session [succeeded]"],
    },
  ];
}
