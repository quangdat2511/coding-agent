import {
  IMPLS,
  type Impl,
  LAYOUTS,
  type Layout,
  type RunConfig,
  SpikeController,
} from "@/controller";
import { runInk } from "@/ink/renderer";
import { countStdout, percentile, type RunMetrics } from "@/metrics";
import { runNative } from "@/native/renderer";
import { runPi } from "@/pi/renderer";

const RENDERERS: Record<Impl, (controller: SpikeController) => Promise<void>> = {
  ink: runInk,
  native: runNative,
  pi: runPi,
};

const USAGE = `coding-agent TUI spike (CDA-17, throwaway)

  bun packages/tui/prototype --impl=<ink|native|pi> --layout=<inline|split|overlay> [--tps=80]
  bun packages/tui/prototype --sweep [--tps=800] [--report=runs.jsonl]

Switch framework with 'f' and layout with '1'/'2'/'3' while it runs; every run is
measured and all runs are compared in the report printed on exit.

--sweep drives all seven grid cells end to end without a human, auto-approving each
gate, and prints the comparison table. Use it for the numbers, the interactive mode
for the feel.
`;

const SWEEP: Array<[Impl, Layout, number | null]> = [
  ["native", "inline", null],
  ["native", "split", null],
  ["native", "overlay", null],
  ["ink", "inline", null],
  ["ink", "split", null],
  ["ink", "overlay", null],
  ["pi", "inline", null],
  ["native", "inline", 7000],
  ["ink", "inline", 7000],
  ["pi", "inline", 7000],
];

function parseArgs(argv: string[]): RunConfig & { report: string | null; sweep: boolean } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (!key) continue;
    if (inline !== undefined) flags.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1]?.startsWith("--")) flags.set(key, argv[++i] as string);
    else flags.set(key, "true");
  }

  if (flags.has("help") || flags.has("h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const impl = flags.get("impl") as Impl | undefined;
  const layout = flags.get("layout") as Layout | undefined;
  if (impl && !IMPLS.includes(impl)) fail(`unknown --impl=${impl}`);
  if (layout && !LAYOUTS.includes(layout)) fail(`unknown --layout=${layout}`);

  const sweep = flags.has("sweep");
  return {
    impl: impl ?? "native",
    layout: layout ?? "inline",
    charsPerSecond: Number(flags.get("tps") ?? (sweep ? 800 : 80)),
    auto: sweep || flags.has("auto"),
    exitOnSettle: sweep || flags.has("auto"),
    cancelAfterMs: flags.has("cancel-after") ? Number(flags.get("cancel-after")) : null,
    report: flags.get("report") ?? null,
    sweep,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[?2026l");
}

function group(value: number): string {
  return value.toLocaleString("en-US");
}

function printReport(runs: RunMetrics[]): void {
  const rows = runs.map((run) => {
    const diff =
      run.candidateRows > 0
        ? `${((run.changedRows / run.candidateRows) * 100).toFixed(1)}%`
        : "n/a";
    return [
      run.impl,
      run.layout,
      String(run.frames),
      group(run.bytesWritten),
      run.frames > 0 ? group(Math.round(run.bytesWritten / run.frames)) : "0",
      percentile(run.frameMs, 50).toFixed(2),
      percentile(run.frameMs, 99).toFixed(2),
      diff,
      String(run.fullRedraws),
      String(run.resizes),
      run.approvalLatencyMs === null ? "-" : `${(run.approvalLatencyMs / 1000).toFixed(1)}s`,
      run.cancelLatencyMs === null ? "-" : `${run.cancelLatencyMs.toFixed(0)}ms`,
      `${(run.durationMs / 1000).toFixed(0)}s`,
    ];
  });

  const header = [
    "impl",
    "layout",
    "frames",
    "bytes",
    "b/frame",
    "p50ms",
    "p99ms",
    "rows-dirty",
    "redraws",
    "resizes",
    "approval",
    "cancel",
    "run",
  ];
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");

  process.stdout.write("\nCDA-17 TUI spike report\n\n");
  process.stdout.write(`${line(header)}\n`);
  process.stdout.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);

  const notes = new Map<string, Set<string>>();
  for (const run of runs) {
    const bucket = notes.get(run.impl) ?? new Set<string>();
    for (const note of run.notes) bucket.add(note);
    notes.set(run.impl, bucket);
  }
  process.stdout.write("\nobserved\n");
  for (const [impl, bucket] of notes) {
    for (const note of bucket) process.stdout.write(`  ${impl.padEnd(7)} ${note}\n`);
  }
  process.stdout.write(
    "\nrows-dirty is the share of screen rows actually rewritten per frame; only the\n" +
      "in-house renderer reports it, because Ink and pi-tui own their own diffing.\n" +
      "pi-tui frame counts come from render() calls and are not directly comparable.\n" +
      "cancel is esc → session stopped. The scripted session aborts instantly, so this\n" +
      "measures the UI path only; a real tool's abort cost is not in this number.\n\n",
  );
}

async function main(): Promise<void> {
  const { report, sweep, ...initial } = parseArgs(Bun.argv.slice(2));
  const queue: RunConfig[] = sweep
    ? SWEEP.map(([impl, layout, cancelAfterMs]) => ({ ...initial, impl, layout, cancelAfterMs }))
    : [initial];
  const io = countStdout();
  const runs: RunMetrics[] = [];

  process.on("uncaughtException", (error) => {
    restoreTerminal();
    io.restore();
    process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });

  for (;;) {
    const config = queue.shift();
    if (!config) break;
    io.reset();
    const controller = new SpikeController(config);
    await RENDERERS[config.impl](controller);
    runs.push(
      controller.metrics.finish(
        config.impl,
        config.cancelAfterMs === null ? config.layout : `${config.layout}+cancel`,
        { bytes: io.bytes, writes: io.writes },
      ),
    );
    if (controller.next) queue.unshift(controller.next);
  }

  io.restore();
  restoreTerminal();
  printReport(runs);

  if (report) {
    const lines = runs.map((run) => JSON.stringify({ at: new Date().toISOString(), ...run }));
    await Bun.write(report, `${lines.join("\n")}\n`);
    process.stdout.write(`wrote ${runs.length} run(s) to ${report}\n`);
  }
  process.exit(0);
}

await main();
