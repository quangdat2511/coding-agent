# CDA-161 — Edit diff prototype

This throwaway Ink demo uses four local fixtures to compare how the edit result
appears in the TUI. From the repository root, with workspace dependencies installed:

```sh
bun packages/tui/prototype-cda-161/index.tsx
```

- `1` / `2` switches between one line-number column and separate old/new columns.
  The one-column layout uses the old number for deletions and the new number for
  additions and context.
- `←` / `→` cycles through the small, large, CRLF and Unicode fixtures.
- `p` switches between green/red and cyan/yellow. `c` toggles color.
- `↑` / `↓`, Page Up / Page Down and Home / End scroll. `q` exits.

Each layout keeps three lines of context near changes and gives the count of
hidden lines. Code wraps at the available column width. `↪` marks a continuation
aligned under the original text. The
large fixture replaces 100 lines and inserts one more across three regions.
The CRLF fixture starts with CRLF text and removes the line separators before
layout. The Unicode fixture includes Vietnamese, CJK, emoji and combining marks.

Use `--no-color` or a nonempty `NO_COLOR` to start and stay in monochrome.
`TERM=dumb` also disables styling. A non-TTY prints one plain snapshot by default.

To render a fixed-width snapshot from Bun:

```sh
bun packages/tui/prototype-cda-161/index.tsx --snapshot --fixture unicode --layout dual --width 54 --no-color
```

`--fixture` accepts `small`, `large`, `crlf` or `unicode`. Use
`--palette classic|contrast`, `--rows N` to limit the number of displayed
diff rows, and `--color` to request ANSI styling for a snapshot.

- [Layout comparison](snapshots/layouts.png) shows the same small edit in both
  layouts at 58 columns.
- [Palette comparison](snapshots/palettes.png) shows the same Unicode diff with
  both palettes in the dual layout at 54 columns.
- [Monochrome examples](snapshots/no-color.png) show the CRLF diff and the start
  of the 100-line edit. The large fixture is fully scrollable in the demo.

The images were rendered from Ink output using an example dark terminal palette.
The exact color shades depend on your terminal theme.
