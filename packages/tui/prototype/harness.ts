import { Terminal } from "@xterm/headless";

const USAGE = `Replay a captured TUI byte stream through a headless terminal and print the screen.

  bun packages/tui/prototype/harness.ts <capture-file> [--cols=110] [--rows=34]

Capture files come from a PTY driver; Bun has no PTY of its own, so the spike drives
runs with an external harness and replays the bytes here. This is the CI-shaped answer
to "can a full-screen TUI be asserted on without an interactive terminal".
`;

function flag(name: string, fallback: number): number {
  const match = Bun.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? Number(match.split("=")[1]) : fallback;
}

const file = Bun.argv[2];
if (!file || file.startsWith("--")) {
  process.stdout.write(USAGE);
  process.exit(1);
}

const cols = flag("cols", 110);
const rows = flag("rows", 34);
const bytes = await Bun.file(file).arrayBuffer();

const terminal = new Terminal({ cols, rows, allowProposedApi: true });
await new Promise<void>((resolve) => {
  terminal.write(new Uint8Array(bytes), () => resolve());
});

const screen: string[] = [];
for (let row = 0; row < rows; row += 1) {
  const line = terminal.buffer.active.getLine(row);
  screen.push((line?.translateToString(true) ?? "").trimEnd());
}

const border = `+${"-".repeat(cols)}+`;
process.stdout.write(`${border}\n`);
for (const line of screen) process.stdout.write(`|${line.padEnd(cols)}|\n`);
process.stdout.write(`${border}\n`);
