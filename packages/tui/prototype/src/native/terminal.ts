import type { SpikeKey } from "@/controller";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR = "\x1b[2J\x1b[H";

export interface RenderStats {
  changedRows: number;
  totalRows: number;
  fullRedraw: boolean;
}

export interface NativeTerminalOptions {
  onKey: (key: SpikeKey) => void;
  onResize: () => void;
  synchronizedOutput: boolean;
}

export class NativeTerminal {
  private previous: string[] = [];
  private previousWidth = 0;
  private started = false;
  private readonly options: NativeTerminalOptions;
  private readonly onData = (chunk: Buffer): void => this.decode(chunk.toString("utf8"));
  private readonly onResize = (): void => {
    this.previous = [];
    this.options.onResize();
  };

  constructor(options: NativeTerminalOptions) {
    this.options = options;
  }

  get size(): { width: number; height: number } {
    return {
      width: process.stdout.columns ?? 80,
      height: process.stdout.rows ?? 24,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
    this.previous = [];
  }

  render(lines: string[]): RenderStats {
    const { width, height } = this.size;
    const fullRedraw = width !== this.previousWidth || this.previous.length === 0;
    this.previousWidth = width;

    const frame: string[] = [];
    let changedRows = 0;
    for (let row = 0; row < height; row += 1) {
      const next = lines[row] ?? "";
      if (!fullRedraw && this.previous[row] === next) continue;
      changedRows += 1;
      frame.push(`\x1b[${row + 1};1H\x1b[2K${next.replace(/ +$/, "")}`);
    }

    if (frame.length > 0) {
      const payload = frame.join("");
      process.stdout.write(
        this.options.synchronizedOutput ? SYNC_BEGIN + payload + SYNC_END : payload,
      );
    }

    this.previous = lines.slice(0, height);
    while (this.previous.length < height) this.previous.push("");

    return { changedRows, totalRows: height, fullRedraw };
  }

  private decode(data: string): void {
    let index = 0;
    while (index < data.length) {
      const rest = data.slice(index);

      if (rest.startsWith("\x03")) {
        this.options.onKey({ name: "interrupt" });
        index += 1;
        continue;
      }

      if (rest.startsWith("\x1b")) {
        const sequence = matchSequence(rest);
        if (sequence) {
          this.options.onKey(sequence.key);
          index += sequence.length;
          continue;
        }
        this.options.onKey({ name: "escape" });
        index += 1;
        continue;
      }

      const char = rest[0] as string;
      if (char === "\r" || char === "\n") {
        this.options.onKey({ name: "enter" });
      } else if (char >= " ") {
        this.options.onKey({ name: "char", value: char });
      }
      index += 1;
    }
  }
}

const SEQUENCES: Array<[string, SpikeKey]> = [
  ["\x1b[A", { name: "up" }],
  ["\x1b[B", { name: "down" }],
  ["\x1b[5~", { name: "pageup" }],
  ["\x1b[6~", { name: "pagedown" }],
  ["\x1b[H", { name: "home" }],
  ["\x1b[F", { name: "end" }],
  ["\x1b[1~", { name: "home" }],
  ["\x1b[4~", { name: "end" }],
  ["\x1bOA", { name: "up" }],
  ["\x1bOB", { name: "down" }],
];

function matchSequence(input: string): { key: SpikeKey; length: number } | null {
  for (const [prefix, key] of SEQUENCES) {
    if (input.startsWith(prefix)) return { key, length: prefix.length };
  }
  return null;
}
