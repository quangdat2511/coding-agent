# Colored, Structured Tool Rows in the TUI

**Ticket:** CDA-153  
**Research Date:** 2026-11-24  
**Context:** Input for [CDA-157](https://datn-fit-hcmus.atlassian.net/browse/CDA-157) (decide the TUI diff
rendering and colored row model) and [CDA-161](https://datn-fit-hcmus.atlassian.net/browse/CDA-161)
(prototype the look). Feeds the map [CDA-149](https://datn-fit-hcmus.atlassian.net/browse/CDA-149).  
**Scope:** What the current row model promises, where a colored edit diff could enter it, what Pi's diff
renderer and theme do at a pinned commit, and what Ink 7.1.1 and chalk 5.6.2 do with ANSI and color
props. This note reports behaviour and recommends an interface; it does not decide the contract.

---

## 1. Question

How should the TUI carry and render a colored edit diff without breaking its current row model? The
parts that matter are the `TranscriptRow` contract, wrapping and truncation, the choice between
structured tone data and ANSI inside row strings, the environment rules (NO_COLOR, TERM=dumb, CI),
what Pi does that translates here, an interface that keeps `tui` importing no sibling package, and the
blast radius on the existing golden tests and on Group 3's footer work.

---

## 2. Short Answer

- **The row model is already color-free and string-based.** `TranscriptRow` is
  `{ entryId, offset, text }`, every entry is laid out to `string[]` before Ink sees it, and each row
  becomes one `<Text wrap="truncate-end">`. Nothing downstream interprets the text: the viewport
  addresses rows by entry id and offset only.
- **Structured tone is the only option that can be switched off reliably.** Ink's `color` prop runs
  through chalk, and chalk 5.6.2 does **not** read `NO_COLOR` (verified empirically). Raw ANSI inside a
  string bypasses chalk's level entirely, so it also ignores `NO_COLOR`; nothing in the TUI could turn
  it off without rewriting rows at render time.
- **ANSI would not break widths, only everything else.** `wrap-ansi` tokenizes escapes and measures
  only the plain text, Ink keeps SGR and OSC and strips other sequences, and `slice-ansi` closes open
  styles when `truncate-end` cuts a line. The costs are a color gate the TUI no longer owns,
  hand-written resets and reopens where a style crosses an existing newline or separate `<Text>`
  rows (`wrap-ansi` only repairs inserted wrap boundaries), and tests that can no longer see tone in
  the row data.
- **Pi's diff is a pre-formatted string, not a component tree.** Lines read `+123 content`,
  `-123 content`, ` 123 content` and `     ...`; the gutter width is global; removed lines are printed
  before added lines; context is 4 before + 4 after with a `...` marker; there are no `@@` hunk
  headers; the whole line including its marker and number gets one theme foreground token, and a
  changed word inside a one-line replacement gets `inverse`. Nothing is truncated — the generic Text
  component wraps it.
- **A recommended interface** is a span list per row, `{ text, tone?, inverse? }[]`, with semantic
  tones and one small module that maps tone to Ink props behind one color gate. Rows stay wrapped to
  the terminal width exactly as today, tone never affects layout, and `transcriptRows()` stays a pure
  function that tests can read without mounting Ink.

---

## 3. The Row Model Today

### 3.1 The model and the rows

`TuiModel` is `{ transcript, pendingApproval? }` ([types.ts L6-L12](../../packages/tui/src/types.ts#L6-L12)).
`TranscriptEntry` is a six-member union; its `tool_call` member carries `toolName`, a one-line
`summary`, a status, an optional `result { content, isError, errorCode?, truncated? }` and an optional
`progress` ([types.ts L44-L74](../../packages/tui/src/types.ts#L44-L74)). No field carries styled text;
`result.content` is a plain string, and the comment at
[types.ts L4-L5](../../packages/tui/src/types.ts#L4-L5) allows later tickets to add optional fields and
union members.

`TranscriptRow` is:

```typescript
export interface TranscriptRow {
  readonly entryId: string;
  readonly offset: number;
  readonly text: string;
}
```

([rows.ts L4-L10](../../packages/tui/src/rows.ts#L4-L10)). `offset` counts the rows of its entry from 0
after wrapping, so an entry id plus an offset does not name the same characters at every width: for
entry `0123456789`, offset 1 is `4567` at width 4 and `89` at width 8. On resize the viewport keeps
the entry and reuses the offset when it is still valid; the text at that offset depends on the
current width.

`transcriptRows(transcript, columns)` lays out the whole transcript and appends one blank row to every
entry but the last ([rows.ts L30-L45](../../packages/tui/src/rows.ts#L30-L45)). `layoutEntry` switches on
kind ([L57-L79](../../packages/tui/src/rows.ts#L57-L79)); a tool call becomes a wrapped header
`"${toolName} ${summary} [${details}]"` followed by `indented(result.content)`
([L88-L106](../../packages/tui/src/rows.ts#L88-L106)), where `INDENT` is two spaces and `PROGRESS_ROWS`
is 5 while the call is still executing ([L14-L18](../../packages/tui/src/rows.ts#L14-L18),
[L118-L125](../../packages/tui/src/rows.ts#L118-L125)).

### 3.2 Wrapping and control characters

`wrap()` is the single choke point:

```typescript
wrapAnsi(display, Math.max(1, columns), { trim: false, hard: true }).split("\n")
```

([rows.ts L147-L155](../../packages/tui/src/rows.ts#L147-L155)). Before wrapping, `toDisplayText` turns
CRLF into LF, expands tabs to **four** spaces, and drops `\p{Cc}` except newline, ESC and characters at
or above U+0080 ([L157-L165](../../packages/tui/src/rows.ts#L157-L165)). ESC is kept on purpose because
Ink keeps SGR, which is what lets the current code call wrapping "the way Ink wraps a `<Text>`".

Layout is cached per entry object in a `WeakMap` keyed on `(entry, columns)`
([L26-L28](../../packages/tui/src/rows.ts#L26-L28), [L47-L55](../../packages/tui/src/rows.ts#L47-L55)).
That works because the projection replaces only the entry an event changed and returns `prev` otherwise
([projection.ts L10-L12](../../packages/coding-agent/src/projection.ts#L10-L12)).

### 3.3 Drawing, truncation and height

`Transcript` puts every row in a fixed-height column and draws one `<Text wrap="truncate-end">` per row;
a blank row is drawn as a single space because an empty `<Text>` takes no height, and truncation is
only a guard against a row Ink measures wider than the frame
([transcript.tsx L4-L18](../../packages/tui/src/session-view.tsx#L4-L18)). The frame's height comes from
`frameLayout`: the transcript gets `screenRows - footer`, where the footer is the Prompt plus at most
one key-hint row, `FOOTER_HEIGHT = 2`
([frame.tsx L9-L41](../../packages/tui/src/frame.tsx#L9-L41)). `draw()` slices the laid-out rows to the
viewport ([render.tsx L92-L139](../../packages/tui/src/render.tsx#L92-L139)), and scrolling anchors on
`(entryId, offset)`, never on text ([viewport.ts L12-L43](../../packages/tui/src/viewport.ts#L12-L43)).

Ink is mounted with `alternateScreen`, `incrementalRendering`, `maxFps: 60`, `exitOnCtrlC: false`, and
`kittyKeyboard: { mode: "auto" }` ([render.tsx L240-L251](../../packages/tui/src/render.tsx#L240-L251)).
`interactive` is decided from `stdout.isTTY` alone ([L235-L237](../../packages/tui/src/render.tsx#L235-L237)).

### 3.4 Tests

Tests build `TuiModel` values by hand and mount the real TUI on `@xterm/headless` 6.0.0. They assert on
whole screens ([render-tui.test.ts L24-L31](../../packages/tui/tests/render-tui.test.ts#L24-L31),
[L60-L73](../../packages/tui/tests/render-tui.test.ts#L60-L73)), on individual cells
([L358-L385](../../packages/tui/tests/render-tui.test.ts#L358-L385)), and occasionally on raw output
substrings when they care about escape sequences such as kitty-keyboard queries
([prompt.test.ts L385-L393](../../packages/tui/tests/prompt.test.ts#L385-L393)). `TestTerminal` exposes
`screen()` (visible text, trailing spaces trimmed) and `cell(row, column)` (characters only)
([support/terminal.ts L124-L129](../../packages/tui/tests/support/terminal.ts#L124-L129)).

Only one test imports `rows.ts`, and only for the `PROGRESS_ROWS` constant
([render-tui.test.ts L4](../../packages/tui/tests/render-tui.test.ts#L4)). There is no `rows.test.ts`, so
layout is tested exclusively through a mounted TUI.

---

## 4. Carrying Color: Structured Tone vs ANSI

### 4.1 ANSI inside `text`

This is the option that needs no type change, and mechanically it would work:

- `toDisplayText` keeps ESC ([rows.ts L164](../../packages/tui/src/rows.ts#L164)).
- `wrap-ansi` 10.0.2 walks the string as plain-text runs and complete escape sequences and measures only
  the plain text ([wrap-ansi index.js L47-L48](https://unpkg.com/wrap-ansi@10.0.2/index.js#L47-L48),
  [L114](https://unpkg.com/wrap-ansi@10.0.2/index.js#L114),
  [L161](https://unpkg.com/wrap-ansi@10.0.2/index.js#L161)).
- Ink sanitizes every text node and keeps only SGR (`...m`) and OSC, dropping cursor movement and other
  control sequences ([sanitize-ansi.ts L5-L33](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/sanitize-ansi.ts#L5-L33),
  applied by [squash-text-nodes.ts L45](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/squash-text-nodes.ts#L45)).
- Ink's `truncate-end` goes through `cli-truncate`'s `slice-ansi`, which closes the styles it leaves open
  ([wrap-text.ts L36-L48](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/wrap-text.ts#L36-L48),
  [slice-ansi L313-L314](https://unpkg.com/slice-ansi@9.0.0/index.js#L313-L314)).

What it costs:

1. **The color gate leaves the TUI.** chalk decides whether `<Text color>` emits anything, from its own
   level ([chalk index.js L169](https://github.com/chalk/chalk/blob/v5.6.2/source/index.js#L169)). A raw
   SGR string is emitted whatever the level is, so `NO_COLOR`, `--no-color` and a piped stdout would
   all still print color.
2. **A style opened outside the wrap path needs its own reset and reopen.** `wrap-ansi` 10.0.2 closes
   and reopens SGR at **inserted wrap boundaries**, so a colored run inside one wrapped string is safe
   across a break it inserts (probe: `abcdef` red at width 3 yields `abc` and `def` with separate
   open/close codes). An existing newline is different: `wrap("\x1b[31mabc\ndef\x1b[39m", 3)` keeps
   the red SGR in the returned string, so writing that one contiguous string preserves the color.
   `def` appears plain only when Ink draws the two rows separately: it closes the style at the end of
   the first row, and the second row starts without an opening code. To keep the color on the next
   row, reopen the style at the start of that row; the row model must do this itself. The risk is
   therefore a pre-styled source string whose existing line breaks the row model splits outside the
   wrap path. Pi avoids this because its `Text` wraps one multi-line string and carries ANSI state
   across lines
   ([pi-tui `utils.ts` L1037-L1060](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/utils.ts#L1037-L1060));
   this row model cannot when it hand-slices a style.
3. **Tone becomes invisible to tests.** A screen assertion still passes (the characters are the same),
   but the only way to check a diff's colors would be to assert on escape bytes, which depend on the
   environment of the test process.
4. **String checks break silently.** `row.text === ""` for a blank row
   ([transcript.tsx L14](../../packages/tui/src/session-view.tsx#L14)) and any future filter on row text
   would see escapes.

The CDA-17 prototype in this repo already does this: `view/theme.ts` holds raw SGR constants and a
`paint()` helper ([theme.ts L3-L19](../../packages/tui/prototype/src/view/theme.ts#L3-L19)), and its Ink
renderer passes those strings straight into `<Text>` ([renderer.tsx L78-L84](../../packages/tui/prototype/src/ink/renderer.tsx#L78-L84))
while also using `<Text color="yellow" bold>` in the same file. It works because Ink keeps the SGR and
wrap-ansi measures the plain text, but it is the mix of two color mechanisms that this note recommends
reducing to one. The prototype README still calls the whole directory throwaway
([README L3-L4](../../packages/tui/prototype/README.md#L3-L4)).

### 4.2 Structured tone

`TranscriptRow` gains tone data and the text stays plain. Wrapping, the `WeakMap` cache key, the blank
row, the viewport and the scroll anchor are all untouched, because none of them looks at characters.
Color is applied at the Ink layer through props, which means chalk's level still governs whether any
escape is emitted, and a test can read tone from `transcriptRows()` without a terminal.

The trade is one new module (tone to Ink props) and a slightly larger `transcript.tsx`. The map already
settled the direction: "rows carry structured tone data, not ANSI, with a prototype to settle the look"
([CDA-149](https://datn-fit-hcmus.atlassian.net/browse/CDA-149)).

---

## 5. Width, Wrapping and Truncation with Color

- **Measurement ignores escapes.** `string-width` 8.3.0 strips ANSI first and then counts grapheme
  clusters and East Asian width ([string-width index.js L1](https://unpkg.com/string-width@8.3.0/index.js#L1)).
  `wrap-ansi` uses it on the plain runs only.
- **Tabs are a shared constant.** `wrap-ansi` counts a tab as 8 columns (`TAB_SIZE = 8`,
  [index.js L49](https://unpkg.com/wrap-ansi@10.0.2/index.js#L49)); Ink's `Text` hands the string to
  `wrapAnsi` without touching tabs
  ([wrap-text.ts L21-L34](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/wrap-text.ts#L21-L34));
  Pi replaces tabs with 3 spaces in its diff
  ([diff.ts L17-L19](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L17-L19))
  and 3 in its Text component
  ([pi-tui `text.ts` L68](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/components/text.ts#L68));
  this repo expands to 4 before wrapping ([rows.ts L14](../../packages/tui/src/rows.ts#L14),
  [L163](../../packages/tui/src/rows.ts#L163)). Any diff path must expand tabs with the same width before
  it measures, or the gutter drifts.
- **Ink only touches text it thinks is too wide.** `render-node-to-output` compares `widestLine(text)`
  with the node's max width and calls `wrapText` only when it is wider
  ([render-node-to-output.ts L140-L158](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render-node-to-output.ts#L140-L158));
  `widest-line` 6 measures each line with `string-width`
  ([widest-line index.js L1-L10](https://unpkg.com/widest-line@6.0.0/index.js#L1-L10)). Rows are
  pre-wrapped here, so this is normally a no-op guard.
- **Span wrapping must be measured once, on the NFC-normalized string.** With tone spans, run the
  existing `wrapAnsi` on the concatenated plain text and cut the spans against the NFC-normalized
  text that `wrapAnsi` measured, not against the pre-wrap input. `wrap-ansi` normalizes to NFC
  internally, so its line lengths can differ from the input: `wrap("e\u0301a", 1)` returns
  `["é", "a"]`, and slicing the original with those lengths yields `["e", "\u0301"]`, losing the
  `a`. A span boundary inside a combining sequence has the same hazard: if `removed` ends with `e`
  and `added` starts with `\u0301a`, NFC merges them into `éa`, and a boundary that splits the
  grapheme has no single tone. The rule is to attach the merged grapheme to the span that contains
  its **first character in the source string**: `é` takes the `removed` tone and `a` the `added`
  tone. This generalizes to emoji clusters: with `removed` ending in `👩` and `added` starting with
  `\u200D💻a`, `👩💻` keeps the `removed` tone and `a` takes the `added` tone. Do not move the
  boundary to the nearest grapheme edge; the first-character rule is the single rule. Wrapping each
  span separately instead would let a span boundary become a line break and would re-wrap long words
  twice.

---

## 6. What Decides Whether Color Appears

### 6.1 Ink's color props

`<Text color>` and `backgroundColor` accept a chalk color name, `#rrggbb`, `rgb(r, g, b)` or
`ansi256(n)`, and are applied by chalk
([Text.tsx L21-L28](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/components/Text.tsx#L21-L28),
[L94-L131](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/components/Text.tsx#L94-L131),
[colorize.ts L12-L70](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/colorize.ts#L12-L70)).
Ink's `dimColor`, `bold`, `inverse`, `underline` and `strikethrough` props are chalk too
([Text.tsx L50-L58](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/components/Text.tsx#L50-L58),
[L110-L128](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/components/Text.tsx#L110-L128)).

At chalk level 0 every one of those is a no-op returning the input string unchanged
([chalk index.js L169](https://github.com/chalk/chalk/blob/v5.6.2/source/index.js#L169)); a hex color
degrades 16m to 256 to 16 colors as the level drops
([chalk index.js L74-L88](https://github.com/chalk/chalk/blob/v5.6.2/source/index.js#L74-L88)).

### 6.2 How chalk 5.6.2 picks the level

chalk 5.6.2 vendors `supports-color`; the default instance takes its level from stdout at import time
(`tty.isatty(1)`; [chalk index.js L29-L31](https://github.com/chalk/chalk/blob/v5.6.2/source/index.js#L29-L31)):

| Check (in order) | Result | Source |
| :--- | :--- | :--- |
| `--no-color`, `--no-colors`, `--color=false`, `--color=never` in argv | level 0 | [L17-L23](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L17-L23) |
| `--color`, `--colors`, `--color=true`, `--color=always` | level 1 | [L24-L31](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L24-L31) |
| `FORCE_COLOR=0` or `false` | level 0 | [L33-L45](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L33-L45) |
| `FORCE_COLOR=1` to `3` (empty means 1) | that level; with `TERM=xterm-256color` and a TTY, `FORCE_COLOR=1` can report 2 | [L33-L45](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L33-L45) |
| stdout not a TTY and no force | 0 | [L90-L92](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L90-L92) |
| `TERM=dumb` on a TTY | force level, else 0 | [L96-L98](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L96-L98) |
| `CI` set, plus GitHub Actions, Gitea Actions or CircleCI | 3 after the TTY check; a pipe returns 0 only when no positive `FORCE_COLOR` is set | [L114-L121](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L114-L121) |
| `CI` set, plus Travis, AppVeyor, GitLab, Buildkite, Drone or CodeShip | 1 | [L122-L125](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L122-L125) |
| `CI` set otherwise | force level, else 0 | [L123](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L123) |
| `COLORTERM=truecolor` | 3 | [L130-L132](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js#L130-L132) |

Measured on macOS with chalk 5.6.2: `CI=1 GITHUB_ACTIONS=1` returns level 3 while stdout is a TTY
and level 0 when stdout is a pipe with no force color; with `FORCE_COLOR=1` the piped case can still
return 3. `FORCE_COLOR=1 TERM=xterm-256color` with a TTY can return level 2. The checks run in the
order above: argv flags, `FORCE_COLOR`, the stdout TTY check, `TERM=dumb`, CI vendor detection, then
`COLORTERM`. The GitHub Actions row only applies after the TTY check; a pipe hits the earlier TTY
row and returns 0 only when no positive `FORCE_COLOR` is set. CDA-157's tests should set
`FORCE_COLOR` explicitly instead of relying on the runner's TTY.

**`NO_COLOR` is not read anywhere in chalk 5.6.2.** The string does not appear in the published
package, and a direct probe of the vendored detector confirms it: with `TERM=xterm-256color` and a TTY,
`NO_COLOR=1` still yields level 3. Ink 7.1.1 depends on `chalk ^5.6.2`
([package.json](https://github.com/vadimdemedes/ink/blob/v7.1.1/package.json)), so `<Text color>` in this
repo ignores `NO_COLOR`. The informal standard asks software to check for it when "present and not an
empty string (regardless of its value)" ([no-color.org](https://no-color.org/)).

Two more environment facts matter here:

- **Ink treats CI as non-interactive by default** — `interactive ?? (!isInCi && stdout.isTTY)`
  ([ink.tsx L1052-L1054](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/ink.tsx#L1052-L1054)) — which
  is why `render.tsx` passes `interactive` explicitly from `stdout.isTTY`
  ([render.tsx L235-L243](../../packages/tui/src/render.tsx#L235-L243)).
- **The repo has no color logic at all today.** The only `CI` and `TERM=dumb` occurrences are the
  `bash` tool explaining the environment it gives child commands
  ([bash.ts L61](../../packages/tools/src/bash.ts#L61)).

A gate the TUI owns would therefore be: `NO_COLOR` set and non-empty, or `TERM=dumb`, or stdout not a
TTY means no color; `FORCE_COLOR` wins over all of it. The exact rule is CDA-157's to pick; what matters
for this note is that **someone has to pick it**, because neither Ink nor chalk does what the standard
asks.

---

## 7. How Pi Renders an Edit Diff

Pi at `8209929fb553e7a8c91dc0894569f9ec43dd201f` renders the diff in two stages: a pure string builder in
`edit-diff.ts` and a colorizer in `components/diff.ts`.

### 7.1 The string the renderer receives

`generateEditDiff` formats jsdiff's line parts into display lines
([edit-diff.ts L589-L626](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L589-L626)):

- **Number format.** Added: `+${lineNum} ${line}`; removed: `-${lineNum} ${line}`; context:
  `${space}${lineNum} ${line}`
  ([L480-L487](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L480-L487),
  [L499-L503](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L499-L503)).
- **Gutter width** is `String(max(countLines(old), countLines(new))).length`, right-aligned with
  `padStart`, so every hunk lines up
  ([L425](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L425),
  [L596](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L596)).
- **Order.** Consecutive removed lines are emitted before consecutive added ones, for a replacement
  ([L478-L489](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L478-L489)).
- **Context.** Four lines by default each side (`contextLines = 4`,
  [L423](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L423));
  a gap between two changes longer than 8 lines shows 4 leading, a marker, 4 trailing; longer runs at
  the edges show 4 and a marker, or are skipped entirely
  ([L497-L562](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L497-L562)).
- **Skip marker.** A space, an empty number field of the gutter width, then ` ...`
  ([L517](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L517)).
- **No hunk headers and no file header.** `@@` lines exist only in the separate `patch` field, built by
  `Diff.structuredPatch` and `formatPatch`
  ([L616-L624](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L616-L624));
  the display string uses only context elision to separate hunks.
- **Bounded computation.** The diff is computed over windows around each replacement with
  `DIFF_WINDOW_MARGIN_LINES = 32` of margin, merging overlapping windows, so cost follows the edit and
  not the file
  ([L582](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L582),
  [L601-L620](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L601-L620)).

### 7.2 Color and intra-line highlight

`renderDiff` parses each line back with `/^([+-\s])(\s*\d*)\s(.*)$/`
([diff.ts L8-L12](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L8-L12)),
replaces tabs with **three** spaces
([L17-L19](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L17-L19)),
and colors whole lines:

- added goes to `toolDiffAdded` with the `+` marker and number included, removed goes to
  `toolDiffRemoved`, and context or anything that does not parse goes to `toolDiffContext`
  ([L87-L155](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L87-L155)).
  There is no separately colored gutter: marker and number share the line's token.
- **Intra-line highlight only for a one-line replacement.** When a run holds exactly one removed and one
  added line, the two contents are word-diffed with `Diff.diffWords` after their common indentation is
  factored out, and each changed word is wrapped in `theme.inverse`
  ([L25-L74](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L25-L74),
  [L123-L133](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L123-L133)).
  Runs with more than one line on either side are shown plain. Pi's tests pin the indentation rule
  ([test/diff.test.ts L9-L34](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/diff.test.ts#L9-L34)).

### 7.3 Theme tokens

Three tokens carry the whole diff: `toolDiffAdded`, `toolDiffRemoved` and `toolDiffContext`, all
foreground slots ([theme-tokens.ts L77-L79](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme-tokens.ts#L77-L79)).
The default dark theme sets them to `green`, `red` and `muted`, where those are theme variables
([dark.json L5-L14](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/dark.json#L5-L14),
[L52-L54](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/dark.json#L52-L54));
the generated system theme maps them to `green`, `red` and `neutral`
([system-theme.ts L92](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/system-theme.ts#L92),
[L111](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/system-theme.ts#L111),
[L115](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/system-theme.ts#L115)).

`theme.fg` writes a precomputed opening sequence plus `\x1b[39m`, or `\x1b[22;39m` for a faint token
([theme.ts L226-L241](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme.ts#L226-L241),
[L297-L301](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme.ts#L297-L301)),
so **line colors bypass chalk entirely** and are emitted even when stdout is piped. `theme.inverse` is
`chalk.inverse`, so the intra-line highlight is the one part that does follow chalk's level
([L314-L332](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme.ts#L314-L332)).
Color depth is `"truecolor"` or `"256color"`, decided from `COLORTERM` and `TERM` hints and overridable
with `PI_TRUE_COLOR`
([terminal-image.ts L71-L77](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/terminal-image.ts#L71-L77),
[L173-L177](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/terminal-image.ts#L173-L177),
[L193-L195](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/terminal-image.ts#L193-L195)).

### 7.4 Placement, wrapping and truncation

- The tool's own header is `edit <path>` with a background that changes with state
  (`toolPendingBg`, `toolSuccessBg`, `toolErrorBg`), then a one-row spacer, then the diff as one `Text`
  with no extra indent
  ([renderers/edit.ts L83-L86](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L83-L86),
  [L115-L151](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L115-L151)).
- The diff is shown only when it differs from the preview Pi rendered before execution
  ([L108-L113](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L108-L113)).
- **Nothing truncates a diff.** The `Text` component hard-wraps long lines with `wrapTextWithAnsi` and
  never cuts a line
  ([pi-tui `text.ts` L74-L75](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/components/text.ts#L74-L75));
  elision is the context marker only. Long edits make tall components, and the scroll view handles them.
- Pi starts the interactive TUI only when both streams are TTYs; otherwise it runs in print mode
  ([main.ts L109-L120](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/main.ts#L109-L120)).
  That is why Pi needs no `NO_COLOR` for the TUI itself.
- The model never sees the diff: the tool returns "Successfully replaced N block(s)" and the diff travels
  only in `details`
  ([edit.ts L204-L212](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L204-L212),
  [L65-L72](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L65-L72)).

---

## 8. What Translates Here

| Pi | This repo | Note |
| :--- | :--- | :--- |
| `+123 content` display lines | A tool `details` payload carrying the same lines, or structured lines | The TUI must not parse tool JSON itself; CDA-155 decides the transport |
| Global gutter width | Computed in `tui` from the largest line number displayed in the block (a five-line block around 1200 still needs four digits); `...` leaves the number column blank at the same width | Width-independent, so it can live in `rows.ts` |
| Marker and number colored with the line | One tone per diff row | `added`, `removed`, `context` |
| Intra-line `inverse` | A second span with an `inverse` flag | Only if the prototype wants it |
| Tabs to 3 spaces | Tabs to 4 spaces already | Keep one number for the whole path |
| No truncation, hard wrap | Pre-wrapped rows, `truncate-end` guard | Unchanged; taller diffs scroll |
| Context 4 + 4, `...` marker | Same constants if the prototype mimics Pi | `...` has no line number and is context-toned |
| `@@` headers only in `patch` | No hunk header in the transcript | The tool-call header already names the file |
| Theme tokens in a JSON theme | A fixed palette this stage | The map puts user themes out of scope |

What does **not** translate: Pi's preview-before-write, its theme-file machinery, and its ANSI delivery.
This repo lays rows out ahead of time and draws one `<Text>` per row, so tone has to be data the
renderer reads, not bytes embedded in the text.

---

## 9. A Recommended Row Interface

The shape below keeps `rows.ts` pure, keeps `tui` importing nothing from a sibling package, and lets a
test assert the diff's structure without a terminal. CDA-157 decides whether to adopt it.

```typescript
// rows.ts
export type Tone = "added" | "removed" | "context" | "meta";

export interface RowSpan {
  readonly text: string;
  // Semantic, not a color: the palette maps it, so tests never depend on an escape.
  readonly tone?: Tone;
  // Pi's intra-line highlight. Absent on every row that does not need it.
  readonly inverse?: boolean;
}

export interface TranscriptRow {
  readonly entryId: string;
  readonly offset: number;
  readonly spans: readonly RowSpan[];
}
```

Properties that matter:

- **Rows stay terminal-width-shaped.** Each row still sums to at most `columns`, produced by the same
  `wrapAnsi` call on the concatenated plain text and then sliced at those offsets. Tone never changes
  layout, so the existing `WeakMap` cache key `(entry, columns)` still applies.
- **A blank row is `spans: []`.** `transcript.tsx` already draws such a row as one space.
- **A convenience reader is worth exporting**, for example `rowText(row): string`, so existing tests,
  debugging and any future search can work with plain text.
- **The renderer maps tone to props.** A single small module, roughly:

  ```tsx
  const TONE = {
    added: { color: "green" },
    removed: { color: "red" },
    context: { color: "gray" },
    meta: { dimColor: true },
  } as const;

  // One gate turns off color, dimColor and inverse together.
  const toneProps = (span: RowSpan, colorEnabled: boolean) =>
    colorEnabled ? { ...(span.tone ? TONE[span.tone] : {}), inverse: span.inverse } : {};

  <Text wrap="truncate-end">
    {row.spans.length === 0
      ? " "
      : row.spans.map((span, index) => (
          <Text key={index} {...toneProps(span, colorEnabled)}>
            {span.text}
          </Text>
        ))}
  </Text>
  ```

  Nested `<Text>` is flattened by Ink before width is measured
  ([squash-text-nodes.ts L10-L46](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/squash-text-nodes.ts#L10-L46),
  [render-node-to-output.ts L140-L158](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render-node-to-output.ts#L140-L158)),
  so a span boundary cannot change the visible width, and each span closes its own style.
- **One gate decides color**, near the Ink mount, not in `rows.ts`: if color is off, the palette maps
  every tone to an empty object and the output is plain text with the same rows.
- **Where the spans come from.** The projection builds `TuiModel`, so it is the natural place to turn a
  tool's `details` into a tui-owned block (for example `{ kind: "diff"; lines: readonly DiffLine[] }`),
  or to leave the entry's existing `result.content` path untouched when there are no details. `tui`
  should accept a block type it owns, not a tool name, which keeps
  [ADR 0004 section 5](../../docs/adr/0004-package-apis-and-dependency-direction.md#L493-L503) intact ("no
  knowledge of models, Model Providers, tools, or Run Events").

Two cheaper variants are worth naming for CDA-157:

- **Row-level tone only** — `TranscriptRow { ..., tone?: Tone }`. One `<Text color>` per row, no nested
  Text, no span slicing. Gives Pi's per-line colors but not its intra-line highlight.
- **Pre-rendered colored strings** — rejected in section 4.1: it moves the color gate out of the TUI and
  makes tone invisible to tests.

---

## 10. Tests

- **Existing golden screens keep passing.** Tone adds fields, not characters. Everything that asserts
  `terminal.screen()` compares visible text, and `screen()` trims trailing spaces
  ([support/terminal.ts L124-L129](../../packages/tui/tests/support/terminal.ts#L124-L129)). A diff block
  only appears for entries that carry details, so hand-built fixtures without details render as they do
  today.
- **New pure tests are the real win.** `transcriptRows()` can be tested with no Ink at all: feed an
  entry with a diff block, assert row count, per-row span tones, gutter alignment, wrapping of a long
  line, and empty-span rows. No `rows.test.ts` exists yet, so this is a new file rather than a rewrite.
- **Color assertions need a forced level.** In `bun test` the default chalk instance's level follows
  `tty.isatty(1)` at import time; under a piped stdout it is 0 and Ink emits no SGR, so a cell-level
  assertion of `getFgColor()` would see the default foreground
  ([xterm-headless typings L1078-L1175](https://unpkg.com/@xterm/headless@6.0.0/typings/xterm-headless.d.ts#L1078-L1175)).
  The harness can already read cells and raw bytes (`cell(row, column)` and `takeOutput()`); a
  `cellStyle()` helper returning `{ fg, inverse, dim }` plus a `FORCE_COLOR=1` test run would cover the
  palette without touching production code.
- **Keep the palette out of golden screens.** If tone is correct and the palette is a pure mapping, an
  escape-level test is optional; the valuable assertions are tones and widths.

---

## 11. Interaction with Group 3's Footer and Status Work

- **Shared vocabulary.** The footer wants the same three-state coloring (normal, warning, error) and the
  same `NO_COLOR` gate. Landing one tone-to-props module now avoids a second color path when the footer
  adds tokens and cost.
- **No layout coupling.** Diff rows live entirely in the transcript; `frameLayout` and `FOOTER_HEIGHT`
  are untouched by this work ([frame.tsx L9-L41](../../packages/tui/src/frame.tsx#L9-L41)). Group 3
  changes the footer height, and the golden tests adapt through `FOOTER_HEIGHT`
  ([render-tui.test.ts L2-L31](../../packages/tui/tests/render-tui.test.ts#L2-L31),
  [support/tui.ts L58-L66](../../packages/tui/tests/support/tui.ts#L58-L66)), except
  `approval.test.ts`, which hard-codes the two footer rows
  ([L15-L20](../../packages/tui/tests/approval.test.ts#L15-L20)), and `prompt.test.ts`, which
  hard-codes `PROMPT_ROW = SCREEN_ROWS - 2` at line 23 and uses it in cursor assertions at lines 71
  and 80
  ([prompt.test.ts L23](../../packages/tui/tests/prompt.test.ts#L23),
  [L71](../../packages/tui/tests/prompt.test.ts#L71),
  [L80](../../packages/tui/tests/prompt.test.ts#L80)).
  Group 3 must review both when the footer height changes.
- **Land the row interface first.** If the footer lands a private color convention before the row model
  exists, the diff work either duplicates it or migrates it. The map says as much: "Group 3 owns TUI
  footer/status work and may also want styled rows, so agree the row interface before landing it"
  ([CDA-149](https://datn-fit-hcmus.atlassian.net/browse/CDA-149)).

---

## 12. Constants to Pin

| Constant | Value | Where |
| :--- | :--- | :--- |
| Row type | `{ entryId, offset, text }` | [rows.ts L6-L10](../../packages/tui/src/rows.ts#L6-L10) |
| Blank separator row | One per entry except the last | [rows.ts L39](../../packages/tui/src/rows.ts#L39) |
| Output indent | 2 spaces | [rows.ts L16](../../packages/tui/src/rows.ts#L16) |
| Tab expansion | 4 spaces | [rows.ts L14](../../packages/tui/src/rows.ts#L14) |
| Progress rows | 5 | [rows.ts L18](../../packages/tui/src/rows.ts#L18) |
| Wrap | `{ trim: false, hard: true }`, at least 1 column | [rows.ts L154](../../packages/tui/src/rows.ts#L154) |
| Row guard | `wrap="truncate-end"` | [transcript.tsx L13](../../packages/tui/src/session-view.tsx#L13) |
| Footer height | 2 rows (Prompt plus hint) | [frame.tsx L9-L11](../../packages/tui/src/frame.tsx#L9-L11) |
| Frame width and height fallback | 80 by 24 | [render.tsx L76-L77](../../packages/tui/src/render.tsx#L76-L77) |
| Frame cap | `maxFps: 60` | [render.tsx L246](../../packages/tui/src/render.tsx#L246) |
| Pi context lines | 4 | [edit-diff.ts L423](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L423) |
| Pi skip marker | space, blank gutter, ` ...` | [edit-diff.ts L517](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L517) |
| Pi diff window | 32 lines | [edit-diff.ts L582](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L582) |
| Pi tab in a diff | 3 spaces | [diff.ts L17-L19](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L17-L19) |
| Pi intra-line rule | one removed plus one added | [diff.ts L121-L133](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L121-L133) |

---

## 13. Edge Cases

1. **The `...` skip row has no line number.** Pi fills the number field with the gutter width and a
   space ([edit-diff.ts L517](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L517)).
   The marker parses back with a blank number field and `...` as its content, so a tone-only row must
   keep the gutter width or the marker shifts.
2. **A line number wider than the terminal.** With `Math.max(1, columns)`, a narrow terminal can leave
   fewer columns than the prefix. Whether to drop the gutter (marker only) below some width is a
   rendering decision; Pi has no such rule and would just wrap the line.
3. **A unified patch is not the display format.** `--- a/file`, `@@ -1,3 +1,4 @@`, `+const x = 1` and
   `-old line` all fail `/^([+-\s])(\s*\d*)\s(.*)$/` because they have no number followed by a space,
   so `renderDiff` emits them unchanged in the context color; only lines shaped `[+-]N content` get
   added or removed colors. A patch line whose content begins with digits and a space would be misread
   as a line number.
4. **Interleaved runs get reordered.** Pi collects all consecutive `-` lines, then all consecutive `+`
   lines, and prints removed first
   ([L102-L142](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L102-L142)).
   That is correct for jsdiff output and wrong for a hand-built diff that alternates.
5. **CRLF files.** Pi diffs LF-normalized content and preserves line endings when writing
   ([edit-diff.ts L11-L13](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L11-L13)).
   The TUI must receive the normalized version; `toDisplayText` would otherwise turn a CRLF into a line
   break inside a row ([rows.ts L161-L163](../../packages/tui/src/rows.ts#L161-L163)).
6. **Empty added or removed lines.** A deleted blank line renders as `-123 ` with a trailing space, which
   `screen()` trims; tests should assert cells or the row model, not the trimmed screen.
7. **Very large diffs.** Pi bounds computation, not display; a 100-line edit yields roughly 100+ rows
   here and the viewport scrolls. With `following`, appending a diff keeps the bottom in view; with an
   anchor, `positionAt` keeps the anchored entry
   ([viewport.ts L32-L43](../../packages/tui/src/viewport.ts#L32-L43)).
8. **Wide characters and Vietnamese.** Already covered for text
   ([render-tui.test.ts L358-L385](../../packages/tui/tests/render-tui.test.ts#L358-L385)); a gutter plus a
   wide character must still land on the expected cells. `string-width` counts grapheme clusters, so
   combining marks stay one column
   ([string-width index.js L1-L25](https://unpkg.com/string-width@8.3.0/index.js#L1-L25)).
9. **A row that is only a tone span with empty text.** Emit `spans: []` (or one span with empty text) and
   keep the blank-row space; an empty nested `<Text>` takes no height.
10. **`NO_COLOR` set to the empty string.** The standard counts only a non-empty value
    ([no-color.org](https://no-color.org/)); chalk does not implement it at all. Pick one reading and put
    it in one place.
11. **Windows console.** Ink clears the screen for every full frame there
    ([support/terminal.ts L22-L25](../../packages/tui/tests/support/terminal.ts#L22-L25)); color does not
    change that, but golden tests for toned rows should stay platform-independent.
12. **`FORCE_COLOR` in CI.** GitHub Actions is level 3 in chalk's table, so a run with `GITHUB_ACTIONS`
    set may print color even though `CI=1` normally means no color. Test assertions must not depend on
    it.

---

## 14. Open Questions for This Repo

- **Where do diff lines come from?** `ToolResult.metadata` currently carries only `durationMs`,
  `approval` and `truncated`
  ([tool-result.ts L31-L39](../../packages/agent-core/src/tool-result.ts#L31-L39)), so nothing can reach
  the TUI until CDA-155 picks a transport.
- **Display string or structured lines?** Pi's renderer consumes the display string its own diff builder
  produced. This repo could instead carry `{ tone, number, text }[]` so the TUI never parses a format.
  CDA-156 and CDA-157 decide.
- **Row tone or spans?** Spans cost a slicing pass in `rows.ts` and nested `<Text>` at draw time; row
  tone costs the intra-line highlight. CDA-161's prototype settles it.
- **Which palette?** Named Ink colors (`green`, `red`, `gray`) are the safest because they follow the
  terminal palette and degrade everywhere; hex, rgb and ansi256 are available
  ([colorize.ts L33-L67](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/colorize.ts#L33-L67)) but add
  a color-depth question this stage may not want.
- **Who owns the color gate?** `render.tsx` (next to the Ink mount) or a new `theme.ts` module, and does
  it read `process.env` directly or take an option for tests? The existing `TuiOptions` already carries
  test seams (`now`, `kittyKeyboard`)
  ([render.tsx L26-L33](../../packages/tui/src/render.tsx#L26-L33)).
- **Where does the diff sit relative to the tool header?** Today the result is indented by two spaces
  under the header ([rows.ts L88-L106](../../packages/tui/src/rows.ts#L88-L106)); Pi puts the diff flush
  at the box padding. Either is a one-line choice in `toolCallLines`.
- **Does the header keep its status text?** The header line is the only place a failed or truncated edit
  is described; a diff block must not hide it.
- **What happens to a diff on a failed edit?** Pi shows the error text instead of a diff
  ([renderers/edit.ts L97-L106](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L97-L106));
  here the projection would simply not attach details.

---

## 15. Sources

Pinned revisions read on 2026-11-24. This worktree has no `node_modules` and `bun install` was not run,
so no test was executed; every claim below was checked against tagged source or a direct probe.

- **This repository** at `adb7a73` (`main`), branch `CDA-153-tui-diff-rows`:
  [`packages/tui/src/rows.ts`](../../packages/tui/src/rows.ts),
  [`transcript.tsx`](../../packages/tui/src/session-view.tsx),
  [`frame.tsx`](../../packages/tui/src/frame.tsx),
  [`render.tsx`](../../packages/tui/src/render.tsx),
  [`types.ts`](../../packages/tui/src/types.ts),
  [`viewport.ts`](../../packages/tui/src/viewport.ts),
  [`overlay.tsx`](../../packages/tui/src/overlay.tsx),
  [tests](../../packages/tui/tests),
  [projection](../../packages/coding-agent/src/projection.ts),
  [ADR 0004 section 5](../../docs/adr/0004-package-apis-and-dependency-direction.md#L493-L503).
- **Pi** at [`8209929`](https://github.com/earendil-works/pi/commit/8209929fb553e7a8c91dc0894569f9ec43dd201f):
  [`components/diff.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts),
  [`core/tools/edit-diff.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts),
  [`core/tools/edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts),
  [`core/tools/renderers/edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts),
  [`theme/theme.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme.ts),
  [`theme/theme-tokens.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme-tokens.ts),
  [`theme/dark.json`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/dark.json),
  [`theme/system-theme.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/system-theme.ts),
  [`packages/tui/src/components/text.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/components/text.ts),
  [`packages/tui/src/utils.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/utils.ts),
  [`packages/tui/src/terminal-image.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/src/terminal-image.ts),
  [`main.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/main.ts),
  [`test/diff.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/diff.test.ts).
- **Ink 7.1.1** (the version in [`packages/tui/package.json`](../../packages/tui/package.json)),
  [v7.1.1 tag](https://github.com/vadimdemedes/ink/tree/v7.1.1):
  [`components/Text.tsx`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/components/Text.tsx),
  [`colorize.ts`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/colorize.ts),
  [`sanitize-ansi.ts`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/sanitize-ansi.ts),
  [`squash-text-nodes.ts`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/squash-text-nodes.ts),
  [`render-node-to-output.ts`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render-node-to-output.ts),
  [`wrap-text.ts`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/wrap-text.ts),
  [`output.ts`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/output.ts),
  [`ink.tsx`](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/ink.tsx),
  [`package.json`](https://github.com/vadimdemedes/ink/blob/v7.1.1/package.json).
- **chalk 5.6.2** (Ink's `^5.6.2` dependency),
  [v5.6.2 tag](https://github.com/chalk/chalk/tree/v5.6.2):
  [`source/index.js`](https://github.com/chalk/chalk/blob/v5.6.2/source/index.js),
  [`source/vendor/supports-color/index.js`](https://github.com/chalk/chalk/blob/v5.6.2/source/vendor/supports-color/index.js).
- **wrap-ansi 10.0.2**: [published source](https://unpkg.com/wrap-ansi@10.0.2/index.js).
- **string-width 8.3.0**: [published source](https://unpkg.com/string-width@8.3.0/index.js).
- **widest-line 6.0.0**: [published source](https://unpkg.com/widest-line@6.0.0/index.js).
- **slice-ansi 9.0.0**: [published source](https://unpkg.com/slice-ansi@9.0.0/index.js).
- **cli-truncate 6.1.1**: [published source](https://unpkg.com/cli-truncate@6.1.1/index.js).
- **@xterm/headless 6.0.0**: [typings](https://unpkg.com/@xterm/headless@6.0.0/typings/xterm-headless.d.ts).
- **NO_COLOR**: [no-color.org](https://no-color.org/) (last updated 2026-11-03).
- **Jira**: [CDA-153](https://datn-fit-hcmus.atlassian.net/browse/CDA-153),
  [CDA-157](https://datn-fit-hcmus.atlassian.net/browse/CDA-157),
  [CDA-161](https://datn-fit-hcmus.atlassian.net/browse/CDA-161),
  [CDA-149](https://datn-fit-hcmus.atlassian.net/browse/CDA-149).
