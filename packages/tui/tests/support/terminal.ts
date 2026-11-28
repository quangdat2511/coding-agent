import { PassThrough, Writable } from "node:stream";
import { Terminal } from "@xterm/headless";
import type { TuiStreams } from "../../src/render.tsx";

// The bytes a terminal sends for the keys the TUI handles.
export const KEYS = {
  enter: "\r",
  backspace: "\u007f",
  escape: "\u001b",
  ctrlC: "\u0003",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
  home: "\u001b[H",
  end: "\u001b[F",
  delete: "\u001b[3~",
  pageUp: "\u001b[5~",
  pageDown: "\u001b[6~",
} as const;

// Headless xterm draws the screen but has no pointer. Feed the reports a terminal sends in SGR
// mouse mode through the same stdin as the keyboard.
export const WHEEL = {
  up: "\u001b[<64;4;2M",
  down: "\u001b[<65;4;2M",
} as const;

// On a Windows console Ink clears the screen for every frame that fills it (isWindowsConsole in
// ink/build/ink.js), and this TUI's frames always fill the screen, so a check that a frame is
// redrawn in place holds on every other platform only.
export const REDRAWS_IN_PLACE = process.platform !== "win32";

// Our Ink patch holds a lone ESC for 100 ms in case the rest of an escape sequence follows, then
// reports the escape key.
const ESCAPE_DELAY_MS = 120;
// How long press() waits for Ink to read a key before deciding nothing is listening.
const READ_TIMEOUT_MS = 1000;

export interface TestTerminal {
  readonly terminal: Terminal;
  readonly streams: TuiStreams;
  // Writes output from an earlier program and waits until xterm has parsed it.
  print(data: string): Promise<void>;
  // The visible rows, without trailing spaces.
  screen(): string[];
  // The character in one cell of the visible screen, or "" for an empty cell.
  cell(row: number, column: number): string;
  // The row and column of the cursor on the visible screen, or undefined while it is hidden.
  cursorAt(): Promise<readonly [row: number, column: number] | undefined>;
  isCursorVisible(): Promise<boolean>;
  // Asks xterm whether a DEC private mode is set.
  isDecModeSet(mode: number): Promise<boolean>;
  // Resizes the screen and emits "resize" on stdout, as a real TTY stream does on SIGWINCH.
  resize(columns: number, rows: number): void;
  // Everything written to stdout since the previous call.
  takeOutput(): string;
  // Types each key in turn, either text or one of KEYS, and resolves once Ink has read them all.
  press(...keys: string[]): Promise<void>;
  // Sends one read without waiting for Ink to decide whether an escape sequence is complete.
  sendChunk(chunk: string): Promise<void>;
  // Whether stdin is in raw mode, in which the terminal sends Ctrl+C as a key instead of a signal.
  isRawMode(): boolean;
  dispose(): void;
}

// The stdout Ink writes to. isTTY makes Ink treat it as a terminal, and columns and rows size the
// layout; without them Ink measures the real terminal. A write is acknowledged only after xterm has
// parsed it, so Ink's flush and exit barriers also wait for the screen to update.
class TerminalOutput extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;
  output = "";
  readonly #terminal: Terminal;

  constructor(terminal: Terminal) {
    super();
    this.#terminal = terminal;
    this.columns = terminal.cols;
    this.rows = terminal.rows;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.output += chunk.toString();
    this.#terminal.write(chunk, callback);
  }
}

// The stdin Ink reads keys from. useInput switches stdin to raw mode and refs it while a component
// listens, and Ink throws for a stream that is not a TTY, so this one reports a TTY and accepts both
// calls. Bytes written to it reach Ink as if they were typed.
class TerminalInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTestTerminal(columns: number, rows: number): TestTerminal {
  // buffer and parser are proposed API in @xterm/headless 6. convertEol turns "\n" into a new line
  // at column 0, as a pty's onlcr setting does for a real terminal.
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true });
  const stdout = new TerminalOutput(terminal);
  const stdin = new TerminalInput();
  const print = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  const line = (row: number) => {
    const buffer = terminal.buffer.active;
    return buffer.getLine(buffer.viewportY + row);
  };

  return {
    terminal,
    // The streams implement the part of a TTY stream that Ink uses, not all of it.
    streams: {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    },
    print,
    // A line keeps cells past the right edge after the terminal narrows; only the visible columns
    // count, as in a real terminal. xterm's own trimming would look past them, so trim here.
    screen: () =>
      Array.from(
        { length: terminal.rows },
        (_, row) => line(row)?.translateToString(false, 0, terminal.cols).trimEnd() ?? "",
      ),
    cell: (row, column) => line(row)?.getCell(column)?.getChars() ?? "",
    async cursorAt() {
      if (!(await this.isCursorVisible())) {
        return undefined;
      }
      const buffer = terminal.buffer.active;
      return [buffer.cursorY, buffer.cursorX] as const;
    },
    isCursorVisible() {
      return this.isDecModeSet(25);
    },
    async isDecModeSet(mode) {
      // xterm answers DECRQM with 1 for set and 2 for reset.
      let reply = "";
      const subscription = terminal.onData((data) => {
        reply += data;
      });
      await print(`\u001b[?${mode}$p`);
      subscription.dispose();
      if (reply === `\u001b[?${mode};1$y`) return true;
      if (reply === `\u001b[?${mode};2$y`) return false;
      throw new Error(`Unexpected DECRQM reply: ${JSON.stringify(reply)}`);
    },
    resize(columns, rows) {
      terminal.resize(columns, rows);
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit("resize");
    },
    takeOutput() {
      const { output } = stdout;
      stdout.output = "";
      return output;
    },
    isRawMode: () => stdin.isRaw,
    async press(...keys) {
      for (const key of keys) {
        await this.sendChunk(key);
        if (key === KEYS.escape) {
          await sleep(ESCAPE_DELAY_MS);
        }
      }
    },
    async sendChunk(chunk) {
      stdin.write(chunk);
      // Ink reads stdin when it emits "readable", which happens after write() returns.
      const deadline = Date.now() + READ_TIMEOUT_MS;
      while (stdin.readableLength > 0) {
        if (Date.now() > deadline) {
          throw new Error(`Ink did not read ${JSON.stringify(chunk)}: no component is listening`);
        }
        await sleep(1);
      }
    },
    dispose: () => terminal.dispose(),
  };
}
