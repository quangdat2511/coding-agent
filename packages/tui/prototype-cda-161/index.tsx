// Throwaway visual comparison for CDA-161.
import { parseArgs } from "node:util";
import { Box, render, renderToString, Text, useApp, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { fixtures } from "./fixtures.ts";
import { diffRows, type Layout } from "./rows.ts";

const palettes = {
  classic: { added: "greenBright", removed: "redBright", context: undefined, fold: "gray" },
  contrast: { added: "cyanBright", removed: "yellowBright", context: undefined, fold: "gray" },
} as const;
type Palette = keyof typeof palettes;

const samples = Object.values(fixtures);
type Sample = (typeof samples)[number];

interface View {
  sample: Sample;
  layout: Layout;
  palette: Palette;
  color: boolean;
}

const MIN_COLUMNS = 24;
const CHROME_ROWS = 9;

function Screen({
  view,
  columns,
  list,
  offset = 0,
  limit = list.rows.length,
  interactive = false,
}: {
  view: View;
  columns: number;
  list: ReturnType<typeof diffRows>;
  offset?: number;
  limit?: number;
  interactive?: boolean;
}) {
  const { sample, layout, palette, color } = view;
  const { rows, heading } = list;
  const last = Math.min(offset + limit, rows.length);
  const muted = color ? "gray" : undefined;
  const paletteLabel = palette === "classic" ? "Green/red" : "Cyan/yellow";

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold={color} wrap="truncate-end">
        CDA-161 · Edit diff prototype
      </Text>
      <Text wrap="truncate-end">
        {samples.indexOf(sample) + 1}/{samples.length} · {sample.label}
      </Text>
      <Text wrap="truncate-end">
        {layout === "compact" ? "A · One column" : "B · Old/new columns"}
        {"  |  "}
        {color ? paletteLabel : "No color"}
      </Text>
      <Text> </Text>
      <Text wrap="truncate-end">edit {sample.path} [completed]</Text>
      <Text wrap="truncate-end">
        {sample.eol} ·{" "}
        <Text color={color ? palettes[palette].added : undefined}>+{sample.added}</Text>
        {"  "}
        <Text color={color ? palettes[palette].removed : undefined}>-{sample.removed}</Text>
      </Text>
      <Text color={muted}>{`  ${heading}   `}</Text>
      <Box flexDirection="column" height={interactive ? limit : undefined}>
        {rows.slice(offset, last).map((row, index) => (
          // A screen row represents a position in this fixture at this width.
          // biome-ignore lint/suspicious/noArrayIndexKey: Physical rows have no identity beyond their position.
          <Text key={offset + index} wrap="truncate-end">
            <Text color={muted}>{`  ${row.gutter} `}</Text>
            <Text color={color ? palettes[palette][row.tone] : undefined}>
              {`${row.marker} ${row.text}`}
            </Text>
          </Text>
        ))}
      </Box>
      {(interactive || last < rows.length) && (
        <Text color={muted}>
          Rows {offset + 1}–{last} / {rows.length}
        </Text>
      )}
      {interactive && (
        <Text wrap="truncate-end">
          {columns >= 74
            ? "1/2 Layout · ←/→ Sample · P Palette · C Color · ↑/↓ or PgUp/PgDn · Q Quit"
            : "1/2  ←/→  P  C  ↑/↓  Q"}
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
  const list = diffRows(view.sample, view.layout, Math.max(columns, MIN_COLUMNS));
  const maxOffset = Math.max(0, list.rows.length - limit);
  const offset = Math.min(scroll, maxOffset);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
    } else if (input === "1" || input === "2") {
      setView({ ...view, layout: input === "1" ? "compact" : "dual" });
    } else if (key.leftArrow || key.rightArrow) {
      const index = samples.indexOf(view.sample) + (key.rightArrow ? 1 : -1);
      setView({ ...view, sample: samples.at(index % samples.length) ?? initial.sample });
      setScroll(0);
    } else if (input === "p") {
      setView({ ...view, palette: view.palette === "classic" ? "contrast" : "classic" });
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
    <Screen {...{ view, columns, list, offset, limit }} interactive />
  );
}

const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: "small" },
    layout: { type: "string", default: "compact" },
    palette: { type: "string", default: "classic" },
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
  --layout compact|dual
  --palette classic|contrast
  --no-color
  --snapshot [--width 80] [--rows N] [--color]`;

if (values.help) {
  console.log(usage);
} else {
  const { fixture, layout, palette } = values;
  const columns = Number(values.width);
  const limit = values.rows === undefined ? undefined : Number(values.rows);
  if (
    !Object.hasOwn(fixtures, fixture) ||
    (layout !== "compact" && layout !== "dual") ||
    (palette !== "classic" && palette !== "contrast") ||
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
      layout,
      palette,
      color,
    };
    if (values.snapshot || !process.stdout.isTTY || !process.stdin.isTTY) {
      const list = diffRows(view.sample, view.layout, columns);
      console.log(renderToString(<Screen {...{ view, columns, list, limit }} />, { columns }));
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
