// PROTOTYPE (CDA-144), throwaway. Renders every variant in every scene on a headless terminal and
// writes the screens to snapshots.txt. Gutter: # selected (inverse) row, . dimmed row.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTerminal } from "../tests/support/terminal.ts";
import { mountApp } from "./app.tsx";
import { VARIANT_NAMES, VARIANTS, type Variant } from "./views.ts";

const COLUMNS = 96;
const ROWS = 26;
const UP = "\u001b[A";
const SHIFT_UP = "\u001b[1;2A";
const ENTER = "\r";
const ALT_ENTER = "\u001b\r";

const intoQueue = (variant: Variant) => [variant === "B" || variant === "D" ? SHIFT_UP : UP];

const PLAN: { title: string; scene: string; keys?: (variant: Variant) => string[] }[] = [
  { title: "Run active, 2 Steers and 2 Follow-ups waiting", scene: "running" },
  { title: "Queue selection mode, entered from the Prompt", scene: "running", keys: intoQueue },
  {
    title: "Send now on the second Follow-up during a run (after the key)",
    scene: "sendnow",
    keys: (variant) => [variant === "C" ? ALT_ENTER : ENTER],
  },
  { title: "The first Follow-up in edit while the run goes on", scene: "editing" },
  { title: "Follow-ups waiting after a failed run", scene: "failed" },
  { title: "After Esc cancelled the run", scene: "cancelled" },
  { title: "Nine items, selection mode", scene: "long", keys: intoQueue },
  { title: "Resume list", scene: "picker" },
  { title: "Resume list: Enter on a Session open elsewhere", scene: "picker", keys: () => [ENTER] },
  { title: "Resume list: lost the race (after Enter)", scene: "race", keys: () => [ENTER] },
  {
    title: "Resume list while Follow-ups wait (after Enter)",
    scene: "pickerwait",
    keys: () => [ENTER],
  },
  { title: "Startup notice: another Coding Agent on this Repository Root", scene: "startup" },
  { title: "Startup notice: a new worktree", scene: "worktree" },
];

const out: string[] = [];
for (const { title, scene, keys } of PLAN) {
  for (const variant of VARIANTS) {
    const terminal = createTestTerminal(COLUMNS, ROWS);
    const app = mountApp(terminal.streams, {
      variant,
      platform: "unix",
      scene,
      kitty: false,
      live: false,
    });
    await app.flush();
    for (const key of keys?.(variant) ?? []) {
      await terminal.press(key);
      await app.flush();
    }
    const buffer = terminal.terminal.buffer.active;
    out.push(`=== ${title} · variant ${variant} (${VARIANT_NAMES[variant]}) · ::${scene} ===`);
    for (let row = 0; row < ROWS; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      let inverse = false;
      let dimmed = 0;
      let filled = 0;
      for (let column = 0; column < COLUMNS; column += 1) {
        const cell = line?.getCell(column);
        if (cell === undefined) {
          continue;
        }
        if (cell.isInverse() && row > 0) {
          inverse = true;
        }
        if (cell.getChars().trim() !== "") {
          filled += 1;
          if (cell.isDim()) {
            dimmed += 1;
          }
        }
      }
      const gutter = inverse ? "#" : filled > 0 && dimmed === filled ? "." : " ";
      out.push(`${gutter} ${line?.translateToString(true) ?? ""}`);
    }
    out.push("");
    await app.unmount();
    terminal.dispose();
  }
}
const file = join(import.meta.dir, "snapshots.txt");
writeFileSync(file, out.join("\n"));
console.log(`wrote ${file}`);
