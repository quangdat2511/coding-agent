import { PassThrough, Writable } from "node:stream";
import { Terminal } from "@xterm/headless";
import type { TuiStreams } from "../../src/render.tsx";

export interface TestTerminal {
  readonly terminal: Terminal;
  readonly streams: TuiStreams;
  // Writes output from an earlier program and waits until xterm has parsed it.
  print(data: string): Promise<void>;
  // The visible rows, without trailing spaces.
  screen(): string[];
  // The character in one cell of the visible screen, or "" for an empty cell.
  cell(row: number, column: number): string;
  isCursorVisible(): Promise<boolean>;
  dispose(): void;
}

// The stdout Ink writes to. isTTY makes Ink treat it as a terminal, and columns and rows size the
// layout; without them Ink measures the real terminal. A write is acknowledged only after xterm has
// parsed it, so Ink's flush and exit barriers also wait for the screen to update.
class TerminalOutput extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  readonly #terminal: Terminal;

  constructor(terminal: Terminal) {
    super();
    this.#terminal = terminal;
    this.columns = terminal.cols;
    this.rows = terminal.rows;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.#terminal.write(chunk, callback);
  }
}

export function createTestTerminal(columns: number, rows: number): TestTerminal {
  // buffer and parser are proposed API in @xterm/headless 6. convertEol turns "\n" into a new line
  // at column 0, as a pty's onlcr setting does for a real terminal.
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true });
  const print = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  const line = (row: number) => {
    const buffer = terminal.buffer.active;
    return buffer.getLine(buffer.viewportY + row);
  };

  return {
    terminal,
    // The streams implement the part of a TTY stream that Ink uses, not all of it.
    streams: {
      stdout: new TerminalOutput(terminal) as unknown as NodeJS.WriteStream,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    },
    print,
    screen: () =>
      Array.from({ length: rows }, (_, row) => line(row)?.translateToString(true) ?? ""),
    cell: (row, column) => line(row)?.getCell(column)?.getChars() ?? "",
    async isCursorVisible() {
      // xterm has no getter for cursor visibility, so ask the terminal with DECRQM for DECTCEM
      // (mode 25). It answers CSI ? 25 ; 1 $ y when the cursor is shown, ; 2 when it is hidden.
      let reply = "";
      const subscription = terminal.onData((data) => {
        reply += data;
      });
      await print("\u001b[?25$p");
      subscription.dispose();
      if (reply === "\u001b[?25;1$y") return true;
      if (reply === "\u001b[?25;2$y") return false;
      throw new Error(`Unexpected DECRQM reply: ${JSON.stringify(reply)}`);
    },
    dispose: () => terminal.dispose(),
  };
}
