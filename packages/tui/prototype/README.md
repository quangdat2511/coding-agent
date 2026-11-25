# TUI spike (CDA-17)

Throwaway. Not a workspace package, not shipped, no tests, no error handling beyond what
makes it run. It exists to answer one question and then be deleted from `main`.

**Question.** Which of CDA-18's two shortlisted approaches should `@coding-agent/tui` adopt,
and which full-screen interaction model should the MVP build first?

**Answer.** Ink 7.1.1 with a project-owned scroll viewport, an inline transcript, approvals
composited over it, and the split rail as an opt-in. Evidence below.

## Run it

```
bun packages/tui/prototype                                   # in-house renderer, inline
bun packages/tui/prototype --impl=ink --layout=split
bun packages/tui/prototype --sweep                           # all ten cells, no human, prints the table
```

`--impl` is `native` (in-house), `ink` (Ink 7.1.1) or `pi` (`@earendil-works/pi-tui` 0.85.1,
reference baseline only). `--layout` is `inline`, `split` or `overlay`. `--tps` sets the
streaming rate in characters per second; crank it to stress the renderer.

While it runs: `f` cycles framework, `1`/`2`/`3` cycles layout, `y`/`a`/`n` answers an
approval, `esc` cancels, `r` replays, `?` shows keys, `q` quits and prints the report. Every
leg is measured separately, so switching mid-session builds the comparison table as you go.

## What it drives

One scripted Agent Run, identical for all three renderers, covering everything CDA-17
asked to see: the task prompt, a streaming transcript, tool calls with their output, an
approval gate that really blocks, `allow-always` suppressing later gates, a rejection with
its recovery path, cancellation of a long-running tool, a verification table with a failing
check, scrollback past a screenful, and a final summary. No model, no network, no
persistence. The script is deterministic, so the numbers are comparable run to run.

`src/session/` owns the events and the state machine. `src/view/` turns that state into
display blocks. The three renderers under `src/native`, `src/ink` and `src/pi` consume the
same view model, so what differs between them is rendering and input, not content.

## Relationship to CDA-18

CDA-18 did not formally select the production renderer. Its merged research document
shortlisted Ink plus a custom viewport and a re-engineered in-house renderer, then delegated
the final selection to this dual-spike. The approving review on PR #11 expressed a preference
for Ink because it is more distinct from Pi and still leaves substantial project-owned work.

That preference is compatible with "building the TUI ourselves." Under the Ink approach, Ink
owns low-level reconciliation, layout, terminal diffing, and terminal lifecycle. This project
still owns the agent run model, transcript virtualization and scrolling, approval UX,
input policy, themes, and all product-specific TUI modules. This is different from adopting
`@earendil-works/pi-tui`, which would reuse a ready-made coding-agent TUI.

## Findings

Bun 1.3.14, macOS, 110x34 terminal, `--sweep --tps=800`.

| impl | layout | bytes | p50 frame | p99 frame |
| --- | --- | --- | --- | --- |
| native | inline | 127 KB | 0.43 ms | 1.09 ms |
| native | split | 269 KB | 0.83 ms | 1.63 ms |
| native | overlay | 128 KB | 0.47 ms | 1.45 ms |
| ink | inline | 129 KB | 8.50 ms | 14.84 ms |
| ink | split | 229 KB | 7.19 ms | 16.30 ms |
| ink | overlay | 126 KB | 8.31 ms | 15.01 ms |
| pi | inline | 172 KB | 0.01 ms | 0.07 ms |

1. **All three run on Bun.** Ink 7.1.1 also provides the terminal facilities the application
   needs: alternate-screen rendering, incremental line rendering, absolute positioning, and
   `suspendTerminal()` for temporarily handing control to a child process.

2. **Ink meets the 60 fps acceptance budget.** With `maxFps: 60` and
   `incrementalRendering: true`, Ink's p99 render time is 14.84-16.30 ms against a 16.7 ms
   budget. The in-house renderer is still 10-15x faster, but that additional headroom does not
   outweigh Ink's lower implementation risk and greater architectural differentiation for the
   MVP.

3. **Ink can composite approvals.** Ink 7.1.1 supports absolute positioning. The approval panel
   now renders over the transcript instead of replacing it, preserving the surrounding context
   with a 15.01 ms p99 render time.

4. **Incremental rendering closes the output gap.** Ink writes roughly the same bytes as the
   in-house renderer for inline and overlay layouts, and fewer bytes for the split layout. The
   earlier result with approximately twice the output was measured with Ink's incremental
   renderer disabled.

5. **The scroll viewport remains project-owned.** Ink supplies clipping and layout primitives,
   but not the agent-specific transcript window, follow-to-bottom behavior, or scroll policy.
   Those remain the central technical contribution under the Ink approach identified by
   CDA-18.

6. **Headless testing does not separate the candidates.** `harness.ts` replays a captured byte
   stream through `@xterm/headless` and asserts on the resulting screen, and that works
   identically for all three. Note that Bun has no PTY, so capturing the stream needs an
   external driver; that is a gap in the Bun testing story, not in any framework.

## Decision

Adopt Ink as the rendering implementation for `@coding-agent/tui`. Keep the production module
deep: callers provide agent/session state and events, while React, Ink, viewport calculations,
terminal lifecycle, and rendering details remain internal. The prototype's three-way renderer
switch is evidence-gathering scaffolding and should not become a production abstraction unless
a second production renderer is actually required.

## Interaction model

Inline is the primary layout. The split rail duplicates what the transcript already says and
produces materially more output, so it belongs behind a toggle for long sessions rather than
in the default. Approvals are the one thing worth lifting out of the flow: an overlay keeps the
diff and the surrounding transcript on screen together. So: inline transcript, approvals
composited over it, split rail opt-in.

## Caveats

`rows-dirty` is only reported by the in-house renderer, since Ink and pi-tui own their own
diffing. pi-tui frame counts come from `render()` calls and are not comparable with the other
two; its byte total is. Cancel latency measures the UI path only, because the scripted session
aborts instantly; a real tool's abort cost is not in that number.

The table is one run on one machine, so it establishes fitness against the stated frame budget,
not a universal performance ranking. Production work should retain a streaming performance
regression test around the selected inline and overlay layouts.
