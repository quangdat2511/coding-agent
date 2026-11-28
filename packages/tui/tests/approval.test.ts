import { afterEach, describe, expect, it } from "bun:test";
import { KEY_HINTS } from "../src/frame.tsx";
import { QUIET_MS } from "../src/input.ts";
import type { PendingApproval, SessionViewEntry, TuiHandlers, TuiModel } from "../src/types.ts";
import { createTestTerminal, KEYS } from "./support/terminal.ts";
import {
  manualClock,
  mountOn,
  prompt,
  unexpectedHandlerCall,
  unmountTui,
  viewport,
} from "./support/tui.ts";

const COLUMNS = 40;
// The Session view gets 8 of these rows, under them the Prompt and the key hint.
const SCREEN_ROWS = 10;
const PROMPT_ROW = SCREEN_ROWS - 2;
// The reason's row in the overlay: above the bottom border, which is the Session view's last row.
const REASON_ROW = PROMPT_ROW - 2;

const WRITE_APPROVAL: PendingApproval = {
  approvalId: "approval-1",
  toolName: "write",
  summary: "src/app.ts (12 lines)",
};

// Eight Session view rows: the header, then line 1 to line 7, filling the viewport.
const SESSION_VIEW_ROWS = [
  "assistant [completed]",
  ...Array.from({ length: 7 }, (_, index) => `line ${index + 1}`),
];
const SESSION_VIEW: readonly SessionViewEntry[] = [
  {
    kind: "assistant",
    id: "m-1",
    text: Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n"),
    status: "completed",
  },
];
// 21 rows: the header, then line 1 to line 20.
const LONG_SESSION_VIEW: readonly SessionViewEntry[] = [
  {
    kind: "assistant",
    id: "m-1",
    text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
    status: "completed",
  },
];

// A row of the bordered overlay on a terminal COLUMNS wide.
const boxed = (text: string) => `│ ${text.padEnd(COLUMNS - 4)} │`;

function mount(model: TuiModel, columns = COLUMNS, screenRows = SCREEN_ROWS) {
  const terminal = createTestTerminal(columns, screenRows);
  const decisions: unknown[][] = [];
  const handlers: TuiHandlers = {
    onSubmit: unexpectedHandlerCall,
    onCancel: unexpectedHandlerCall,
    onApproval(...args) {
      decisions.push(args);
    },
  };
  const clock = manualClock();
  const tui = mountOn(terminal, model, handlers, {}, { now: clock.now });
  // The person stops typing and reads the overlay, so the next key decides.
  const pause = () => clock.advance(QUIET_MS);
  return { tui, terminal, decisions, clock, pause };
}

afterEach(unmountTui);

describe("Approval overlay", () => {
  it("shows the tool and its mutation summary over the bottom of the Session view", async () => {
    const { tui, terminal } = mount({ sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    const rows = viewport(terminal);
    // The rows above the overlay still show the Session view.
    expect(rows.slice(0, 4)).toEqual(["assistant [completed]", "line 1", "line 2", "line 3"]);
    expect(rows.slice(4)).toEqual([
      "╭──────────────────────────────────────╮",
      boxed("write src/app.ts (12 lines)"),
      boxed("y allow · n deny"),
      "╰──────────────────────────────────────╯",
    ]);
  });

  it("allows on y, then hands the keys back to the Prompt", async () => {
    const { tui, terminal, decisions, pause } = mount({
      sessionView: SESSION_VIEW,
      pendingApproval: WRITE_APPROVAL,
    });
    // Enter decides nothing, so an Enter meant for the Prompt cannot allow the call.
    await terminal.press(KEYS.enter);
    pause();
    await terminal.press("y");
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "allow"]]);
    // The overlay closes at once, before the host takes the Approval out of the model.
    expect(viewport(terminal)).toEqual(SESSION_VIEW_ROWS);

    await terminal.press("abc");
    await tui.flush();
    expect(prompt(terminal)).toBe("> abc");
    expect(decisions).toHaveLength(1);
  });

  it("decides nothing while the person is still typing", async () => {
    const { tui, terminal, decisions, clock, pause } = mount({ sessionView: SESSION_VIEW });
    await terminal.press("bu");
    tui.update({ sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    // "yarn" typed for the Prompt at a few keys a second, as the overlay opens.
    for (const key of "yarn") {
      clock.advance(150);
      await terminal.press(key);
    }
    await tui.flush();
    expect(decisions).toEqual([]);
    expect(viewport(terminal).at(-2)).toBe(boxed("y allow · n deny"));

    // Once the person stops and reads the overlay, y allows.
    pause();
    await terminal.press("y");
    expect(decisions).toEqual([["approval-1", "allow"]]);
    await tui.flush();
    expect(prompt(terminal)).toBe("> bu");
  });

  it("decides nothing on a key that comes right after the overlay opens", async () => {
    const { tui, terminal, decisions, clock } = mount({ sessionView: SESSION_VIEW });
    // The keyboard has been quiet for a minute when the Approval arrives.
    clock.advance(60_000);
    tui.update({ sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL });
    clock.advance(QUIET_MS - 1);
    await terminal.press("y");
    expect(decisions).toEqual([]);

    clock.advance(QUIET_MS);
    await terminal.press("y");
    expect(decisions).toEqual([["approval-1", "allow"]]);
  });

  it("covers the Session view rows it is drawn over", async () => {
    // Rows as wide as the terminal, which would show through any cell the overlay left unwritten.
    const text = Array.from({ length: 7 }, () => "x".repeat(COLUMNS)).join("\n");
    const { tui, terminal, pause } = mount({
      sessionView: [{ kind: "assistant", id: "m-1", text, status: "completed" }],
      pendingApproval: WRITE_APPROVAL,
    });
    pause();
    await terminal.press("n");
    await tui.flush();
    expect(viewport(terminal).slice(4)).toEqual([
      `╭${"─".repeat(COLUMNS - 2)}╮`,
      boxed("write src/app.ts (12 lines)"),
      boxed("Reason:"),
      `╰${"─".repeat(COLUMNS - 2)}╯`,
    ]);
  });

  it("hides the cursor while allow or deny is chosen", async () => {
    const { tui, terminal } = mount({ sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    expect(await terminal.cursorAt()).toBeUndefined();
  });

  it("asks for a reason on n and denies with it on Enter", async () => {
    const { tui, terminal, decisions, pause } = mount({
      sessionView: SESSION_VIEW,
      pendingApproval: WRITE_APPROVAL,
    });
    pause();
    await terminal.press("n");
    await tui.flush();
    expect(viewport(terminal).at(-2)).toBe(boxed("Reason:"));
    // The cursor waits in the reason, inside the border and after the label.
    expect(await terminal.cursorAt()).toEqual([REASON_ROW, 10]);
    expect(decisions).toEqual([]);

    // The reason is edited with the same keys as the Prompt.
    await terminal.press("quá ro", KEYS.left, KEYS.left, "rủi ", KEYS.end, KEYS.backspace, "o");
    await tui.flush();
    expect(viewport(terminal).at(-2)).toBe(boxed("Reason: quá rủi ro"));
    await terminal.press(KEYS.enter);
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "deny", "quá rủi ro"]]);
    expect(viewport(terminal)).toEqual(SESSION_VIEW_ROWS);

    await terminal.press("abc");
    await tui.flush();
    expect(prompt(terminal)).toBe("> abc");
  });

  it("denies without a reason when none is typed", async () => {
    const { tui, terminal, decisions, pause } = mount({
      sessionView: SESSION_VIEW,
      pendingApproval: WRITE_APPROVAL,
    });
    pause();
    await terminal.press("n", "   ", KEYS.enter);
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "deny"]]);
  });

  it("keeps the cursor of a reason wider than its row in view", async () => {
    const { tui, terminal, pause } = mount({
      sessionView: SESSION_VIEW,
      pendingApproval: WRITE_APPROVAL,
    });
    pause();
    const reason = "0123456789".repeat(4);
    await terminal.press("n", reason);
    await tui.flush();
    // The 28 columns after the label hold the last 27 characters and the cursor after them.
    expect(viewport(terminal).at(-2)).toBe(boxed(`Reason: ${reason.slice(-27)}`));
    expect(await terminal.cursorAt()).toEqual([REASON_ROW, 37]);
    await terminal.press(KEYS.home);
    await tui.flush();
    expect(viewport(terminal).at(-2)).toBe(boxed(`Reason: ${reason.slice(0, 28)}`));
    expect(await terminal.cursorAt()).toEqual([REASON_ROW, 10]);
  });

  it("never moves the reason's cursor on scroll keys, nor the viewport on its editing keys", async () => {
    const { tui, terminal, pause } = mount({
      sessionView: LONG_SESSION_VIEW,
      pendingApproval: WRITE_APPROVAL,
    });
    pause();
    await terminal.press("n", "abc", KEYS.left);
    await tui.flush();
    const following = viewport(terminal)[0];
    expect(await terminal.cursorAt()).toEqual([REASON_ROW, 12]);
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    const scrolled = viewport(terminal)[0];
    expect(scrolled).not.toBe(following);
    expect(await terminal.cursorAt()).toEqual([REASON_ROW, 12]);
    await terminal.press(KEYS.home, KEYS.end, KEYS.up, KEYS.down, KEYS.backspace);
    await tui.flush();
    expect(viewport(terminal)[0]).toBe(scrolled);
    expect(viewport(terminal).at(-2)).toBe(boxed("Reason: ab"));
  });

  it("keeps the text typed in the Prompt and gives it back the keys and the cursor", async () => {
    const { tui, terminal, decisions, pause } = mount({ sessionView: SESSION_VIEW });
    await terminal.press("Sửa");
    tui.update({ sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa");
    // Keys go to the overlay, not to the Prompt.
    await terminal.press("x", KEYS.backspace);
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa");

    // y decides, and the text after it goes to the Prompt again.
    pause();
    await terminal.press("y", " test");
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "allow"]]);
    expect(prompt(terminal)).toBe("> Sửa test");
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 10]);
  });

  it("opens each Approval afresh, never with the previous one's state", async () => {
    const { tui, terminal, decisions, pause } = mount({
      sessionView: SESSION_VIEW,
      pendingApproval: WRITE_APPROVAL,
    });
    // A reason half typed for the first Approval when a second one replaces it.
    pause();
    await terminal.press("n", "abc");
    const second: PendingApproval = {
      approvalId: "approval-2",
      toolName: "bash",
      summary: "rm -rf dist",
    };
    tui.update({ sessionView: SESSION_VIEW, pendingApproval: second });
    await tui.flush();
    expect(viewport(terminal).slice(-3, -1)).toEqual([
      boxed("bash rm -rf dist"),
      boxed("y allow · n deny"),
    ]);
    pause();
    await terminal.press("n", KEYS.enter);
    await tui.flush();
    expect(decisions).toEqual([["approval-2", "deny"]]);

    // A third Approval after a decision opens the overlay again.
    const third: PendingApproval = { approvalId: "approval-3", toolName: "edit", summary: "x.md" };
    tui.update({ sessionView: SESSION_VIEW, pendingApproval: third });
    pause();
    await terminal.press("y");
    await tui.flush();
    expect(decisions).toEqual([
      ["approval-2", "deny"],
      ["approval-3", "allow"],
    ]);
  });

  it("leaves the Session view's scroll position and content as they were", async () => {
    // 21 rows in a viewport of 8 rows.
    const sessionView = LONG_SESSION_VIEW;
    const { tui, terminal, pause } = mount({ sessionView });
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    const inView = viewport(terminal);
    expect(inView[0]).toBe("line 6");

    tui.update({ sessionView, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    expect(viewport(terminal).slice(0, 4)).toEqual(inView.slice(0, 4));
    // Page Up and Page Down still scroll the Session view under the overlay.
    await terminal.press(KEYS.pageDown);
    await tui.flush();
    expect(viewport(terminal)[0]).toBe("line 13");
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    expect(viewport(terminal).slice(0, 4)).toEqual(inView.slice(0, 4));

    pause();
    await terminal.press("y");
    await tui.flush();
    expect(viewport(terminal)).toEqual(inView);
  });

  it("shows the keys of each step under the Prompt", async () => {
    const { tui, terminal, pause } = mount(
      { sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL },
      80,
    );
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe(KEY_HINTS.approval);
    expect(KEY_HINTS.approval).toBe("Esc/Ctrl+C cancel · y allow · n deny · PgUp/PgDn scroll");
    pause();
    await terminal.press("n");
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe("Esc/Ctrl+C cancel · Enter deny · PgUp/PgDn scroll");
  });

  it("cuts a long summary at half the Session view so the choices always show", async () => {
    const summary = Array.from({ length: 30 }, (_, index) => `file${index}.ts`).join(" ");
    const { tui, terminal } = mount({
      sessionView: SESSION_VIEW,
      pendingApproval: { ...WRITE_APPROVAL, summary },
    });
    await tui.flush();
    const rows = viewport(terminal);
    // Half of the 8 rows for the summary, one for the choices and two for the border.
    expect(rows.slice(0, 1)).toEqual(["assistant [completed]"]);
    expect(rows[1]).toMatch(/^╭─+╮$/);
    expect(rows.slice(2, 6).every((row) => row.startsWith("│ "))).toBe(true);
    expect(rows[5]).toMatch(/…\s*│$/);
    expect(rows[6]).toBe(boxed("y allow · n deny"));
  });

  it("drops the border but keeps the summary on a Session view of three rows", async () => {
    // Three Session view rows, the Prompt and the key hint.
    const { tui, terminal, decisions, pause } = mount(
      { sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL },
      COLUMNS,
      5,
    );
    await tui.flush();
    expect(viewport(terminal)).toEqual([
      "line 5",
      " write src/app.ts (12 lines)",
      " y allow · n deny",
    ]);
    pause();
    await terminal.press("y");
    expect(decisions).toEqual([["approval-1", "allow"]]);
  });

  it("covers the Session view under the reason when it has no border", async () => {
    // Rows as wide as the terminal, which would show through any cell the overlay left unwritten.
    const text = Array.from({ length: 7 }, () => "x".repeat(20)).join("\n");
    const { tui, terminal, pause } = mount(
      {
        sessionView: [{ kind: "assistant", id: "m-1", text, status: "completed" }],
        pendingApproval: WRITE_APPROVAL,
      },
      20,
      4,
    );
    pause();
    await terminal.press("n");
    await tui.flush();
    expect(viewport(terminal)).toEqual([" write src/app.ts…", " Reason:"]);
  });

  it("allows nothing on a Session view with no room for the summary, but still denies", async () => {
    // One Session view row, the Prompt and the key hint.
    const { tui, terminal, decisions, pause } = mount(
      { sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL },
      80,
      3,
    );
    await tui.flush();
    expect(terminal.screen()).toEqual([
      " write · n deny · enlarge to allow",
      ">",
      KEY_HINTS.denyOnly,
    ]);
    pause();
    await terminal.press("y");
    expect(decisions).toEqual([]);
    pause();
    await terminal.press("n", KEYS.enter);
    expect(decisions).toEqual([["approval-1", "deny"]]);
  });

  it("allows nothing when the terminal has no row for the overlay", async () => {
    const { tui, terminal, decisions, pause } = mount(
      { sessionView: SESSION_VIEW, pendingApproval: WRITE_APPROVAL },
      COLUMNS,
      1,
    );
    await tui.flush();
    expect(terminal.screen()).toEqual([">"]);
    pause();
    await terminal.press("y");
    expect(decisions).toEqual([]);
  });
});
