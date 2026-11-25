# CDA-161 — Edit diff prototype

This throwaway Ink demo shows the layout and palette selected in the
[CDA-161 review](https://datn-fit-hcmus.atlassian.net/browse/CDA-161?focusedCommentId=10379).
From the repository root, with workspace dependencies installed:

```sh
bun packages/tui/prototype-cda-161/index.tsx
```

- `←` / `→` cycles through the small, large, CRLF and Unicode fixtures.
- `c` toggles color.
- `↑` / `↓`, Page Up / Page Down and Home / End scroll. `q` exits.

The single gutter shows old line numbers for deletions and new line numbers for
additions and context. There are up to four context lines on each side of a
change. `…` marks a gap in unchanged lines. The large fixture replaces 100 lines
and inserts one more across three regions. Its sample payload omits the middle
and shows `Diff truncated` between the retained ends.

The gutter and both metadata markers use ANSI gray. The marker and code use ANSI
green for additions and red for deletions. Code wraps at the available width
with a `↪` continuation under the original text. Tabs use four spaces. The CRLF
fixture splits lines before layout, and the Unicode fixture includes Vietnamese,
CJK, emoji and combining marks.

Use `--no-color` or a nonempty `NO_COLOR` to start and stay in monochrome.
`TERM=dumb` also disables styling. A non-TTY prints one plain snapshot by default.

To render a fixed-width snapshot from Bun:

```sh
bun packages/tui/prototype-cda-161/index.tsx --snapshot --fixture unicode --width 54 --no-color
```

`--fixture` accepts `small`, `large`, `crlf` or `unicode`. Use `--rows N` to
print the first N display rows, and `--color` to request ANSI styling.

- [Reviewed layout and palette](snapshots/reviewed.png) shows the small and
  Unicode edits.
- [Monochrome examples](snapshots/no-color.png) show the CRLF diff and the rows
  around the truncation marker in the large diff.

The images were rendered from Ink output using an example dark terminal palette.
The exact color shades depend on your terminal theme.
