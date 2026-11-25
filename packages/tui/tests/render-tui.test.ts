import { afterEach, describe, expect, it } from "bun:test";
import { FOOTER_HEIGHT, KEY_HINTS } from "../src/frame.tsx";
import * as publicApi from "../src/index.ts";
import { PROGRESS_ROWS } from "../src/rows.ts";
import type { SessionViewEntry } from "../src/types.ts";
import { createTestTerminal } from "./support/terminal.ts";
import { mountOn, unmountTui } from "./support/tui.ts";

const COLUMNS = 80;
const ROWS = 24;

const TASK = "Sửa test đang lỗi trong src/math.ts";

// These tests press no keys, so the TUI never calls a handler.
function mount(
  sessionView: readonly SessionViewEntry[],
  terminal = createTestTerminal(COLUMNS, ROWS),
) {
  return { tui: mountOn(terminal, { sessionView }), terminal };
}

// The whole visible screen while the TUI runs: the given Session view rows, empty rows down to the
// Prompt, then the empty Prompt and the key hint.
function screenOf(...rows: string[]): string[] {
  return [...shellScreen(...rows).slice(0, ROWS - FOOTER_HEIGHT), ">", KEY_HINTS.prompt];
}

// The whole visible screen without the TUI: the given rows, then empty rows to the bottom.
function shellScreen(...rows: string[]): string[] {
  return [...rows, ...Array.from({ length: ROWS - rows.length }, () => "")];
}

afterEach(unmountTui);

describe("renderTui", () => {
  it("draws user messages, assistant text, Tool Calls and Tool Results", async () => {
    const { tui, terminal } = mount([
      { kind: "user", id: "task", text: TASK },
      {
        kind: "assistant",
        id: "message-1",
        text: "I'll read the file first.",
        status: "completed",
      },
      {
        kind: "tool_call",
        id: "call-1",
        toolName: "read",
        summary: "src/math.ts",
        status: "succeeded",
        result: {
          content: "1 | export const add = (a: number, b: number) => a - b;",
          isError: false,
        },
      },
      { kind: "tool_call", id: "call-2", toolName: "bash", summary: "bun test", status: "queued" },
    ]);
    await tui.flush();

    expect(terminal.screen()).toEqual(
      screenOf(
        `> ${TASK}`,
        "",
        "assistant [completed]",
        "I'll read the file first.",
        "",
        "read src/math.ts [succeeded]",
        "  1 | export const add = (a: number, b: number) => a - b;",
        "",
        "bash bun test [queued]",
      ),
    );
  });

  it("shows every status, Tool Result, error code and truncation as text", async () => {
    const { tui, terminal } = mount([
      { kind: "assistant", id: "a-1", text: "Reading", status: "streaming" },
      { kind: "assistant", id: "a-2", text: "Stopped", status: "cancelled" },
      { kind: "assistant", id: "a-3", text: "Provider error", status: "failed" },
      { kind: "tool_call", id: "t-1", toolName: "bash", summary: "bun test", status: "executing" },
      {
        kind: "tool_call",
        id: "t-2",
        toolName: "bash",
        summary: "bun test",
        status: "failed",
        result: { content: "1 fail", isError: true, errorCode: "NON_ZERO_EXIT", truncated: true },
      },
      {
        kind: "tool_call",
        id: "t-3",
        toolName: "write",
        summary: "src/math.ts",
        status: "denied",
        result: { content: "Approval denied", isError: true, errorCode: "APPROVAL_DENIED" },
      },
      {
        kind: "tool_call",
        id: "t-4",
        toolName: "edit",
        summary: "src/math.ts",
        status: "skipped",
        skipReason: "CANCELLED",
      },
      { kind: "tool_call", id: "t-5", toolName: "bash", summary: "sleep 60", status: "cancelled" },
    ]);
    await tui.flush();

    expect(terminal.screen()).toEqual(
      screenOf(
        "assistant [streaming]",
        "Reading",
        "",
        "assistant [cancelled]",
        "Stopped",
        "",
        "assistant [failed]",
        "Provider error",
        "",
        "bash bun test [executing]",
        "",
        "bash bun test [failed, NON_ZERO_EXIT, truncated]",
        "  1 fail",
        "",
        "write src/math.ts [denied, APPROVAL_DENIED]",
        "  Approval denied",
        "",
        "edit src/math.ts [skipped, CANCELLED]",
        "",
        "bash sleep 60 [cancelled]",
      ),
    );
  });

  it("shows reasoning before the text, indented under the header", async () => {
    const { tui, terminal } = mount([
      {
        kind: "assistant",
        id: "a-1",
        reasoning: "The test expects a sum.",
        text: "I'll fix add.",
        status: "streaming",
      },
    ]);
    await tui.flush();

    expect(terminal.screen()).toEqual(
      screenOf("assistant [streaming]", "  The test expects a sum.", "I'll fix add."),
    );
  });

  it("shows the last rows of an executing call's progress, and its result once it completes", async () => {
    const progress = `${Array.from({ length: 8 }, (_, line) => `line ${line + 1}`).join("\n")}\n`;
    const running: SessionViewEntry = {
      kind: "tool_call",
      id: "t-1",
      toolName: "bash",
      summary: "bun test",
      status: "executing",
      progress,
    };
    const { tui, terminal } = mount([running]);
    await tui.flush();

    expect(terminal.screen()).toEqual(
      screenOf(
        "bash bun test [executing]",
        ...Array.from({ length: PROGRESS_ROWS }, (_, row) => `  line ${row + 4}`),
      ),
    );

    tui.update({
      sessionView: [
        {
          kind: "tool_call",
          id: "t-1",
          toolName: "bash",
          summary: "bun test",
          status: "succeeded",
          result: { content: "8 pass", isError: false },
        },
      ],
    });
    await tui.flush();

    expect(terminal.screen()).toEqual(screenOf("bash bun test [succeeded]", "  8 pass"));
  });

  it("shows Verification, notices and the settled outcome of an Agent Run", async () => {
    const { tui, terminal } = mount([
      { kind: "verification", id: "v-1", status: "running" },
      {
        kind: "verification",
        id: "v-2",
        status: "continue",
        evidence: ["bun test exited 1"],
      },
      { kind: "notice", id: "n-1", text: "limit reached: maxToolCalls (observed 101, limit 100)" },
      {
        kind: "outcome",
        id: "o-1",
        status: "failed",
        failure: { code: "LIMIT_EXCEEDED", message: "Tool Call limit exceeded" },
        workspaceChanged: true,
        partialChangesPossible: true,
      },
      {
        kind: "outcome",
        id: "o-2",
        status: "succeeded",
        workspaceChanged: false,
        partialChangesPossible: false,
      },
    ]);
    await tui.flush();

    expect(terminal.screen()).toEqual(
      screenOf(
        "verification [running]",
        "",
        "verification [continue]",
        "  bun test exited 1",
        "",
        "limit reached: maxToolCalls (observed 101, limit 100)",
        "",
        "run [failed, LIMIT_EXCEEDED]",
        "  Tool Call limit exceeded",
        "  workspace changed, partial changes possible",
        "",
        "run [succeeded]",
        "  workspace unchanged",
      ),
    );
  });

  it("redraws in place on every update without duplicating content", async () => {
    const task: SessionViewEntry = { kind: "user", id: "task", text: TASK };
    const { tui, terminal } = mount([task]);
    await tui.flush();
    expect(terminal.screen()).toEqual(screenOf(`> ${TASK}`));

    // Updates between two frames collapse into one frame showing the latest model.
    for (const text of ["I'll", "I'll read", "I'll read the file first."]) {
      tui.update({
        sessionView: [task, { kind: "assistant", id: "m-1", text, status: "streaming" }],
      });
    }
    await tui.flush();
    expect(terminal.screen()).toEqual(
      screenOf(`> ${TASK}`, "", "assistant [streaming]", "I'll read the file first."),
    );

    const message: Extract<SessionViewEntry, { kind: "assistant" }> = {
      kind: "assistant",
      id: "m-1",
      text: "I'll read the file first.",
      status: "completed",
    };
    const read = {
      kind: "tool_call",
      id: "c-1",
      toolName: "read",
      summary: "src/math.ts",
    } as const;
    const steps: { sessionView: SessionViewEntry[]; screen: string[] }[] = [
      {
        sessionView: [task, message, { ...read, status: "queued" }],
        screen: screenOf(
          `> ${TASK}`,
          "",
          "assistant [completed]",
          "I'll read the file first.",
          "",
          "read src/math.ts [queued]",
        ),
      },
      {
        sessionView: [task, message, { ...read, status: "executing" }],
        screen: screenOf(
          `> ${TASK}`,
          "",
          "assistant [completed]",
          "I'll read the file first.",
          "",
          "read src/math.ts [executing]",
        ),
      },
      {
        sessionView: [
          task,
          message,
          {
            ...read,
            status: "succeeded",
            result: { content: "1 | export const add = (a, b) => a - b;", isError: false },
          },
        ],
        screen: screenOf(
          `> ${TASK}`,
          "",
          "assistant [completed]",
          "I'll read the file first.",
          "",
          "read src/math.ts [succeeded]",
          "  1 | export const add = (a, b) => a - b;",
        ),
      },
      {
        // Shorter lines and fewer rows must not leave characters from the previous frame behind.
        sessionView: [task, { ...message, text: "Done.", status: "failed" }],
        screen: screenOf(`> ${TASK}`, "", "assistant [failed]", "Done."),
      },
    ];
    for (const step of steps) {
      tui.update({ sessionView: step.sessionView });
      await tui.flush();
      expect(terminal.screen()).toEqual(step.screen);
    }

    expect(terminal.terminal.buffer.active.type).toBe("alternate");
    expect(terminal.terminal.buffer.active.baseY).toBe(0);
  });

  it("restores the main screen, cursor, and mouse mode after unmount", async () => {
    const terminal = createTestTerminal(COLUMNS, ROWS);
    await terminal.print("$ coding-agent\n");
    const { tui } = mount([{ kind: "user", id: "task", text: TASK }], terminal);
    await tui.flush();
    expect(terminal.terminal.buffer.active.type).toBe("alternate");
    expect(terminal.terminal.modes.mouseTrackingMode).toBe("vt200");
    expect(await terminal.isDecModeSet(1006)).toBe(true);
    // While the TUI draws, the cursor sits in the empty Prompt, after its marker.
    expect(await terminal.cursorAt()).toEqual([ROWS - FOOTER_HEIGHT, 2]);

    await tui.unmount();

    expect(terminal.terminal.buffer.active.type).toBe("normal");
    expect(terminal.terminal.modes.mouseTrackingMode).toBe("none");
    expect(await terminal.isDecModeSet(1006)).toBe(false);
    expect(await terminal.isCursorVisible()).toBe(true);
    expect(terminal.screen()).toEqual(shellScreen("$ coding-agent"));
    expect(terminal.terminal.buffer.active.cursorY).toBe(1);
  });

  it("starts the Session view on the first row when the shell left the cursor lower", async () => {
    const terminal = createTestTerminal(COLUMNS, ROWS);
    const shellOutput = Array.from({ length: 10 }, (_, index) => `shell line ${index + 1}`);
    await terminal.print(`${shellOutput.join("\n")}\n`);
    expect(terminal.terminal.buffer.active.cursorY).toBe(10);

    const { tui } = mount([{ kind: "user", id: "task", text: TASK }], terminal);
    await tui.flush();

    expect(terminal.terminal.buffer.active.type).toBe("alternate");
    expect(terminal.screen()).toEqual(screenOf(`> ${TASK}`));

    await tui.unmount();
    expect(terminal.screen()).toEqual(shellScreen(...shellOutput));
    expect(terminal.terminal.buffer.active.cursorY).toBe(10);
  });

  it("draws Vietnamese text on the expected row and columns", async () => {
    // Precomposed characters, one cell each.
    expect(TASK.normalize("NFC")).toBe(TASK);
    const result = "Đã sửa: hàm add() trả về a + b";
    const { tui, terminal } = mount([
      { kind: "user", id: "task", text: TASK },
      {
        kind: "tool_call",
        id: "c-1",
        toolName: "edit",
        summary: "src/math.ts",
        status: "succeeded",
        result: { content: result, isError: false },
      },
    ]);
    await tui.flush();

    expect(terminal.screen()[0]).toBe(`> ${TASK}`);
    expect(terminal.cell(0, 2)).toBe("S");
    expect(terminal.cell(0, 3)).toBe("ử");
    expect(terminal.cell(0, 2 + TASK.length - 1)).toBe("s");
    expect(terminal.cell(0, 2 + TASK.length)).toBe("");

    expect(terminal.screen()[3]).toBe(`  ${result}`);
    expect(terminal.cell(3, 2)).toBe("Đ");
    expect(terminal.cell(3, 3)).toBe("ã");
    expect(terminal.cell(3, 2 + result.length - 1)).toBe("b");
  });

  it("replaces control characters that would move the cursor", async () => {
    const call = {
      kind: "tool_call",
      id: "c-1",
      toolName: "bash",
      summary: "cat notes.txt",
      status: "succeeded",
      result: { content: "name\tvalue\r\nbell\u0007 and back\bspace", isError: false },
    } as const;
    const { tui, terminal } = mount([call]);
    await tui.flush();
    const expected = ["bash cat notes.txt [succeeded]", "  name    value", "  bell and backspace"];
    expect(terminal.screen()).toEqual(screenOf(...expected));

    tui.update({ sessionView: [call, { kind: "user", id: "next", text: "Thanks" }] });
    await tui.flush();
    expect(terminal.screen()).toEqual(screenOf(...expected, "", "> Thanks"));
  });

  it("ignores updates after unmount and unmounts once", async () => {
    const { tui, terminal } = mount([{ kind: "user", id: "task", text: TASK }]);
    await tui.flush();

    const unmounted = tui.unmount();
    expect(tui.unmount()).toBe(unmounted);
    await unmounted;
    tui.update({ sessionView: [{ kind: "user", id: "late", text: "Too late" }] });
    await tui.flush();

    expect(terminal.terminal.buffer.active.type).toBe("normal");
    expect(terminal.screen()).toEqual(shellScreen());
  });

  it("leaves no beforeExit listener behind", async () => {
    const listeners = process.listenerCount("beforeExit");
    const { tui } = mount([{ kind: "user", id: "task", text: TASK }]);
    await tui.unmount();
    expect(process.listenerCount("beforeExit")).toBe(listeners);
  });

  it("exports only renderTui at runtime", () => {
    expect(Object.keys(publicApi)).toEqual(["renderTui"]);
  });
});
