import { afterEach, describe, expect, it } from "bun:test";
import type { TranscriptEntry, TuiHandlers, TuiModel } from "../src/types.ts";
import { createTestTerminal, KEYS } from "./support/terminal.ts";
import { mountOn, prompt, unexpectedHandlerCall, unmountTui, viewport } from "./support/tui.ts";

const COLUMNS = 40;
// The transcript gets 8 of these rows, under them the Prompt and the key hint.
const SCREEN_ROWS = 10;
const PROMPT_ROW = SCREEN_ROWS - 2;
// The reason's row in the overlay: above the bottom border, which is the transcript's last row.
const REASON_ROW = PROMPT_ROW - 2;

type Approval = NonNullable<TuiModel["pendingApproval"]>;

const WRITE_APPROVAL: Approval = {
  approvalId: "approval-1",
  toolName: "write",
  summary: "src/app.ts (12 lines)",
};

// Eight transcript rows: the header, then line 1 to line 7, filling the viewport.
const TRANSCRIPT_ROWS = [
  "assistant [completed]",
  ...Array.from({ length: 7 }, (_, index) => `line ${index + 1}`),
];
const TRANSCRIPT: readonly TranscriptEntry[] = [
  {
    kind: "assistant",
    id: "m-1",
    text: Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n"),
    status: "completed",
  },
];

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
  const tui = mountOn(terminal, model, handlers);
  return { tui, terminal, decisions };
}

afterEach(unmountTui);

describe("Approval overlay", () => {
  it("shows the tool and its mutation summary over the bottom of the transcript", async () => {
    const { tui, terminal } = mount({ transcript: TRANSCRIPT, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    const rows = viewport(terminal);
    // The rows above the overlay still show the transcript.
    expect(rows.slice(0, 4)).toEqual(["assistant [completed]", "line 1", "line 2", "line 3"]);
    expect(rows.slice(4)).toEqual([
      "╭──────────────────────────────────────╮",
      "│ write src/app.ts (12 lines)          │",
      "│ y allow · n deny                     │",
      "╰──────────────────────────────────────╯",
    ]);
  });

  it("allows on y, then hands the keys back to the Prompt", async () => {
    const { tui, terminal, decisions } = mount({
      transcript: TRANSCRIPT,
      pendingApproval: WRITE_APPROVAL,
    });
    // Enter decides nothing, so an Enter meant for the Prompt cannot allow the call.
    await terminal.press(KEYS.enter, "y");
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "allow"]]);
    // The overlay closes at once, before the host takes the Approval out of the model.
    expect(viewport(terminal)).toEqual(TRANSCRIPT_ROWS);

    await terminal.press("abc");
    await tui.flush();
    expect(prompt(terminal)).toBe("> abc");
    expect(decisions).toHaveLength(1);
  });

  it("covers the transcript rows it is drawn over", async () => {
    // Rows as wide as the terminal, which would show through any cell the overlay left unwritten.
    const text = Array.from({ length: 7 }, () => "x".repeat(COLUMNS)).join("\n");
    const { tui, terminal } = mount({
      transcript: [{ kind: "assistant", id: "m-1", text, status: "completed" }],
      pendingApproval: WRITE_APPROVAL,
    });
    await terminal.press("n");
    await tui.flush();
    expect(viewport(terminal).slice(4)).toEqual([
      `╭${"─".repeat(COLUMNS - 2)}╮`,
      `${"│ write src/app.ts (12 lines)".padEnd(COLUMNS - 1)}│`,
      `${"│ Reason:".padEnd(COLUMNS - 1)}│`,
      `╰${"─".repeat(COLUMNS - 2)}╯`,
    ]);
  });

  it("hides the cursor while allow or deny is chosen", async () => {
    const { tui, terminal } = mount({ transcript: TRANSCRIPT, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    expect(await terminal.cursorAt()).toBeUndefined();
  });

  it("asks for a reason on n and denies with it on Enter", async () => {
    const { tui, terminal, decisions } = mount({
      transcript: TRANSCRIPT,
      pendingApproval: WRITE_APPROVAL,
    });
    await terminal.press("n");
    await tui.flush();
    expect(viewport(terminal).at(-2)).toBe(`${"│ Reason:".padEnd(COLUMNS - 1)}│`);
    // The cursor waits in the reason, inside the border and after the label.
    expect(await terminal.cursorAt()).toEqual([REASON_ROW, 10]);
    expect(decisions).toEqual([]);

    // The reason is edited with the same keys as the Prompt.
    await terminal.press("quá ro", KEYS.left, KEYS.left, "rủi ", KEYS.end, KEYS.backspace, "o");
    await tui.flush();
    expect(viewport(terminal).at(-2)).toBe(`${"│ Reason: quá rủi ro".padEnd(COLUMNS - 1)}│`);
    await terminal.press(KEYS.enter);
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "deny", "quá rủi ro"]]);
    expect(viewport(terminal)).toEqual(TRANSCRIPT_ROWS);

    await terminal.press("abc");
    await tui.flush();
    expect(prompt(terminal)).toBe("> abc");
  });

  it("denies without a reason when none is typed", async () => {
    const { tui, terminal, decisions } = mount({
      transcript: TRANSCRIPT,
      pendingApproval: WRITE_APPROVAL,
    });
    await terminal.press("n", "   ", KEYS.enter);
    await tui.flush();
    expect(decisions).toEqual([["approval-1", "deny"]]);
  });

  it("keeps the text typed in the Prompt and gives it back the keys and the cursor", async () => {
    const { tui, terminal } = mount({ transcript: TRANSCRIPT });
    await terminal.press("Sửa");
    tui.update({ transcript: TRANSCRIPT, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa");
    // Keys go to the overlay, not to the Prompt.
    await terminal.press("x", KEYS.backspace);
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa");

    await terminal.press("y", " test");
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa test");
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 10]);
  });

  it("opens each Approval afresh, never with the previous one's state", async () => {
    const { tui, terminal, decisions } = mount({
      transcript: TRANSCRIPT,
      pendingApproval: WRITE_APPROVAL,
    });
    // A reason half typed for the first Approval when a second one replaces it.
    await terminal.press("n", "abc");
    const second: Approval = { approvalId: "approval-2", toolName: "bash", summary: "rm -rf dist" };
    tui.update({ transcript: TRANSCRIPT, pendingApproval: second });
    await tui.flush();
    expect(viewport(terminal).slice(-3, -1)).toEqual([
      "│ bash rm -rf dist                     │",
      "│ y allow · n deny                     │",
    ]);
    await terminal.press("n", KEYS.enter);
    await tui.flush();
    expect(decisions).toEqual([["approval-2", "deny"]]);

    // A third Approval after a decision opens the overlay again.
    const third: Approval = { approvalId: "approval-3", toolName: "edit", summary: "README.md" };
    tui.update({ transcript: TRANSCRIPT, pendingApproval: third });
    await terminal.press("y");
    await tui.flush();
    expect(decisions).toEqual([
      ["approval-2", "deny"],
      ["approval-3", "allow"],
    ]);
  });

  it("leaves the transcript's scroll position and content as they were", async () => {
    // 21 rows: the header, then line 1 to line 20, in a viewport of 8 rows.
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const transcript: TranscriptEntry[] = [
      { kind: "assistant", id: "m-1", text, status: "completed" },
    ];
    const { tui, terminal } = mount({ transcript });
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    const inView = viewport(terminal);
    expect(inView[0]).toBe("line 6");

    tui.update({ transcript, pendingApproval: WRITE_APPROVAL });
    await tui.flush();
    expect(viewport(terminal).slice(0, 4)).toEqual(inView.slice(0, 4));
    // Page Up and Page Down still scroll the transcript under the overlay.
    await terminal.press(KEYS.pageDown);
    await tui.flush();
    expect(viewport(terminal)[0]).toBe("line 13");
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    expect(viewport(terminal).slice(0, 4)).toEqual(inView.slice(0, 4));

    await terminal.press("y");
    await tui.flush();
    expect(viewport(terminal)).toEqual(inView);
  });

  it("shows the keys of each step under the Prompt", async () => {
    const { tui, terminal } = mount(
      { transcript: TRANSCRIPT, pendingApproval: WRITE_APPROVAL },
      80,
    );
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe(
      "Esc/Ctrl+C cancel · y allow · n deny · PgUp/PgDn scroll",
    );
    await terminal.press("n");
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe("Esc/Ctrl+C cancel · Enter deny · PgUp/PgDn scroll");
  });

  it("cuts a long summary at half the transcript so the choices always show", async () => {
    const summary = Array.from({ length: 30 }, (_, index) => `file${index}.ts`).join(" ");
    const { tui, terminal } = mount({
      transcript: TRANSCRIPT,
      pendingApproval: { ...WRITE_APPROVAL, summary },
    });
    await tui.flush();
    const rows = viewport(terminal);
    // Half of the 8 rows for the summary, one for the choices and two for the border.
    expect(rows.slice(0, 1)).toEqual(["assistant [completed]"]);
    expect(rows[1]).toMatch(/^╭─+╮$/);
    expect(rows.slice(2, 6).every((row) => row.startsWith("│ "))).toBe(true);
    expect(rows[5]).toMatch(/…\s*│$/);
    expect(rows[6]).toBe("│ y allow · n deny                     │");
  });

  it("draws only the choices on a transcript too short for the border", async () => {
    // Two transcript rows, the Prompt and the key hint.
    const { tui, terminal, decisions } = mount(
      { transcript: TRANSCRIPT, pendingApproval: WRITE_APPROVAL },
      COLUMNS,
      4,
    );
    await tui.flush();
    expect(viewport(terminal)).toEqual(["line 6", " y allow · n deny"]);
    await terminal.press("y");
    expect(decisions).toEqual([["approval-1", "allow"]]);
  });
});
