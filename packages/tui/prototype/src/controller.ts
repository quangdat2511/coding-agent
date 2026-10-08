import { Metrics } from "./metrics.ts";
import type { ApprovalDecision } from "./session/events.ts";
import { ScriptedSession } from "./session/script.ts";
import { SessionViewModel } from "./session/view-model.ts";

export type Impl = "ink" | "native" | "pi";
export type Layout = "inline" | "split" | "overlay";

export const IMPLS: Impl[] = ["ink", "native", "pi"];
export const LAYOUTS: Layout[] = ["inline", "split", "overlay"];

export interface RunConfig {
  impl: Impl;
  layout: Layout;
  charsPerSecond: number;
  auto: boolean;
  exitOnSettle: boolean;
  cancelAfterMs: number | null;
}

export type SpikeKey =
  | { name: "char"; value: string }
  | {
      name:
        | "up"
        | "down"
        | "pageup"
        | "pagedown"
        | "home"
        | "end"
        | "escape"
        | "enter"
        | "interrupt";
    };

export type KeyOutcome = "quit" | "switch" | "handled" | "ignored";

export class SpikeController {
  readonly metrics = new Metrics();
  readonly config: RunConfig;

  view = new SessionViewModel();
  session: ScriptedSession;
  scrollTop = 0;
  follow = true;
  showHelp = false;
  contentHeight = 0;
  viewportHeight = 0;
  next: RunConfig | null = null;

  private onChange: () => void = () => {};
  private onExit: () => void = () => {};
  private unsubscribe: () => void = () => {};
  private autoDecisions = 0;

  constructor(config: RunConfig) {
    this.config = config;
    this.session = this.spawn();
  }

  start(onChange: () => void, onExit: () => void): void {
    this.onChange = onChange;
    this.onExit = onExit;
    if (this.config.cancelAfterMs !== null) {
      const session = this.session;
      setTimeout(() => {
        this.metrics.cancelPressed();
        session.cancel("auto-cancel");
        this.onChange();
      }, this.config.cancelAfterMs);
    }
    void this.session.run();
  }

  stop(): void {
    this.session.cancel("shutting down");
    this.unsubscribe();
  }

  setViewport(contentHeight: number, viewportHeight: number): void {
    this.contentHeight = contentHeight;
    this.viewportHeight = viewportHeight;
    if (this.follow) this.scrollTop = Math.max(0, contentHeight - viewportHeight);
    else this.scrollTop = this.clamp(this.scrollTop);
  }

  handleKey(key: SpikeKey): KeyOutcome {
    if (key.name === "interrupt") return "quit";

    if (key.name === "char") {
      switch (key.value) {
        case "q":
          return "quit";
        case "f":
          return this.switchTo({ impl: this.cycle(IMPLS, this.config.impl) });
        case "1":
          return this.switchTo({ layout: "inline" });
        case "2":
          return this.switchTo({ layout: "split" });
        case "3":
          return this.switchTo({ layout: "overlay" });
        case "?":
          this.showHelp = !this.showHelp;
          return this.changed();
        case "r":
          this.replay();
          return this.changed();
        case "y":
          return this.decide("allow-once");
        case "a":
          return this.decide("allow-always");
        case "n":
          return this.decide("reject");
        case "g":
          return this.scrollTo(0);
        case "G":
          return this.scrollToEnd();
        case "j":
          return this.scrollBy(1);
        case "k":
          return this.scrollBy(-1);
        default:
          return "ignored";
      }
    }

    switch (key.name) {
      case "escape":
        this.metrics.cancelPressed();
        return this.session.cancel("operator pressed esc") ? this.changed() : "ignored";
      case "up":
        return this.scrollBy(-1);
      case "down":
        return this.scrollBy(1);
      case "pageup":
        return this.scrollBy(-Math.max(1, this.viewportHeight - 2));
      case "pagedown":
        return this.scrollBy(Math.max(1, this.viewportHeight - 2));
      case "home":
        return this.scrollTo(0);
      case "end":
        return this.scrollToEnd();
      case "enter":
        return this.decide("allow-once");
      default:
        return "ignored";
    }
  }

  private decide(decision: ApprovalDecision): KeyOutcome {
    if (!this.view.pendingApproval) return "ignored";
    this.metrics.approvalAnswered();
    return this.session.decide(decision) ? this.changed() : "ignored";
  }

  private replay(): void {
    this.session.cancel("replayed");
    this.unsubscribe();
    this.view = new SessionViewModel();
    this.scrollTop = 0;
    this.follow = true;
    this.session = this.spawn();
    void this.session.run();
  }

  private spawn(): ScriptedSession {
    const session = new ScriptedSession({ charsPerSecond: this.config.charsPerSecond });
    this.unsubscribe = session.subscribe((event) => {
      this.view.apply(event);
      if (event.kind === "approval-requested") {
        this.metrics.approvalShown();
        if (this.config.auto) {
          setTimeout(() => {
            this.metrics.approvalAnswered();
            session.decide(this.autoDecisions++ === 0 ? "allow-once" : "allow-always");
            this.onChange();
          }, 400);
        }
      }
      if (event.kind === "session-cancelled") this.metrics.cancelAcknowledged();
      if (event.kind === "session-settled" && this.config.exitOnSettle) {
        setTimeout(() => this.onExit(), 600);
      }
      this.onChange();
    });
    return session;
  }

  private switchTo(patch: Partial<RunConfig>): KeyOutcome {
    this.next = { ...this.config, ...patch };
    return "switch";
  }

  private cycle<T>(values: T[], current: T): T {
    const index = values.indexOf(current);
    return values[(index + 1) % values.length] as T;
  }

  private scrollBy(delta: number): KeyOutcome {
    this.metrics.scrollActions += 1;
    return this.scrollTo(this.scrollTop + delta);
  }

  private scrollTo(target: number): KeyOutcome {
    const clamped = this.clamp(target);
    this.follow = clamped >= this.maxScroll();
    if (clamped === this.scrollTop) return "handled";
    this.scrollTop = clamped;
    return this.changed();
  }

  private scrollToEnd(): KeyOutcome {
    this.follow = true;
    return this.scrollTo(this.maxScroll());
  }

  private maxScroll(): number {
    return Math.max(0, this.contentHeight - this.viewportHeight);
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(value, this.maxScroll()));
  }

  private changed(): KeyOutcome {
    this.onChange();
    return "handled";
  }
}
