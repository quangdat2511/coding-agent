// Throwaway preview of the diff layout and palette chosen in CDA-161.
import { parseArgs } from "node:util";
import { Box, render, renderToString, Text, useApp, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { fixtures } from "./fixtures.ts";
import { diffRows } from "./rows.ts";

const palette = {
  added: "green",
  removed: "red",
  context: undefined,
  meta: "gray",
} as const;

const samples = Object.values(fixtures);
type Sample = (typeof samples)[number];

interface View {
  sample: Sample;
  color: boolean;
}

const MIN_COLUMNS = 24;
const CHROME_ROWS = 8;

function Screen({
  view,
  columns,
  diff,
  offset = 0,
  limit = diff.length,
  interactive = false,
}: {
  view: View;
  columns: number;
  diff: ReturnType<typeof diffRows>;
  offset?: number;
  limit?: number;
  interactive?: boolean;
}) {
  const { sample, color } = view;
  const last = Math.min(offset + limit, diff.length);
  const muted = color ? palette.meta : undefined;

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold={color} wrap="truncate-end">
        CDA-161 · Edit diff prototype
      </Text>
      <Text wrap="truncate-end">
        {samples.indexOf(sample) + 1}/{samples.length} · {sample.label}
      </Text>
      <Text wrap="truncate-end">{color ? "ANSI green/red" : "No color"}</Text>
      <Text> </Text>
      <Text wrap="truncate-end">edit {sample.path} [completed]</Text>
      <Text wrap="truncate-end">
        {sample.eol} · <Text color={color ? palette.added : undefined}>+{sample.added}</Text>
        {"  "}
        <Text color={color ? palette.removed : undefined}>-{sample.removed}</Text>
      </Text>
      <Box flexDirection="column" height={interactive ? limit : undefined}>
        {diff.slice(offset, last).map(({ spans: [gutter, body] }, index) => (
          // A screen row represents a position in this fixture at this width.
          // biome-ignore lint/suspicious/noArrayIndexKey: Physical rows have no identity beyond their position.
          <Text key={offset + index} wrap="truncate-end">
            <Text color={color ? palette[gutter.tone] : undefined}>{gutter.text}</Text>
            <Text color={color ? palette[body.tone] : undefined}>{body.text}</Text>
          </Text>
        ))}
      </Box>
      {(interactive || last < diff.length) && (
        <Text color={muted}>
          Rows {offset + 1}–{last} / {diff.length}
        </Text>
      )}
      {interactive && (
        <Text wrap="truncate-end">
          {columns >= 54 ? "←/→ Sample · C Color · ↑/↓ or PgUp/PgDn · Q Quit" : "←/→  C  ↑/↓  Q"}
        </Text>
      )}
    </Box>
  );
}

function Interactive({ initial }: { initial: View }) {
  const [view, setView] = useState(initial);
  const [scroll, setScroll] = useState(0);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const limit = Math.max(1, rows - CHROME_ROWS);
  const diff = diffRows(view.sample.rows, Math.max(columns, MIN_COLUMNS));
  const maxOffset = Math.max(0, diff.length - limit);
  const offset = Math.min(scroll, maxOffset);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
    } else if (key.leftArrow || key.rightArrow) {
      const index = samples.indexOf(view.sample) + (key.rightArrow ? 1 : -1);
      setView({ ...view, sample: samples.at(index % samples.length) ?? initial.sample });
      setScroll(0);
    } else if (input === "c" && initial.color) {
      setView({ ...view, color: !view.color });
    } else if (key.home || key.end) {
      setScroll(key.end ? maxOffset : 0);
    } else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const step = key.pageUp || key.pageDown ? limit : 1;
      const next = offset + (key.upArrow || key.pageUp ? -step : step);
      setScroll(Math.max(0, Math.min(next, maxOffset)));
    }
  });

  return columns < MIN_COLUMNS || rows <= CHROME_ROWS ? (
    <Text>Enlarge the terminal.</Text>
  ) : (
    <Screen {...{ view, columns, diff, offset, limit }} interactive />
  );
}

const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: "small" },
    snapshot: { type: "boolean" },
    width: { type: "string", default: "80" },
    rows: { type: "string" },
    color: { type: "boolean" },
    "no-color": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const usage = `bun packages/tui/prototype-cda-161/index.tsx [options]
  --fixture small|large|crlf|unicode
  --no-color
  --snapshot [--width 80] [--rows N] [--color]`;

if (values.help) {
  console.log(usage);
} else {
  const { fixture } = values;
  const columns = Number(values.width);
  const limit = values.rows === undefined ? undefined : Number(values.rows);
  if (
    !Object.hasOwn(fixtures, fixture) ||
    !Number.isSafeInteger(columns) ||
    columns < MIN_COLUMNS ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
  ) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    const color =
      !values["no-color"] &&
      !process.env.NO_COLOR &&
      process.env.TERM !== "dumb" &&
      !["0", "false"].includes(process.env.FORCE_COLOR ?? "") &&
      (values.color === true || Boolean(process.stdout.isTTY));
    const view: View = {
      sample: fixtures[fixture as keyof typeof fixtures],
      color,
    };
    if (values.snapshot || !process.stdout.isTTY || !process.stdin.isTTY) {
      const diff = diffRows(view.sample.rows, columns);
      console.log(renderToString(<Screen {...{ view, columns, diff, limit }} />, { columns }));
    } else {
      await render(<Interactive initial={view} />, {
        alternateScreen: true,
        interactive: true,
        exitOnCtrlC: true,
        patchConsole: false,
      }).waitUntilExit();
    }
  }
}
