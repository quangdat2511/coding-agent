# TUI spike (CDA-17)

Throwaway. Not a workspace package, not shipped, no tests, no error handling beyond what
makes it run. It exists to answer one question and then be deleted from `main`.

**Question.** Which of CDA-18's two shortlisted approaches should `@coding-agent/tui` adopt,
and which full-screen interaction model should the MVP build first?

**Answer.** The in-house micro-TUI, with an inline transcript, approvals composited over it,
and the split rail as an opt-in. Evidence below.

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

One scripted Agent Session, identical for all three renderers, covering everything CDA-17
asked to see: the task prompt, a streaming transcript, tool calls with their output, an
approval gate that really blocks, `allow-always` suppressing later gates, a rejection with
its recovery path, cancellation of a long-running tool, a verification table with a failing
check, scrollback past a screenful, and a final summary. No model, no network, no
persistence. The script is deterministic, so the numbers are comparable run to run.

`src/session/` owns the events and the state machine. `src/view/` turns that state into
display blocks. The three renderers under `src/native`, `src/ink` and `src/pi` consume the
same view model, so what differs between them is rendering and input, not content.

## Findings

Bun 1.3.14, macOS, 110x34 terminal, `--sweep --tps=800`.

| impl | layout | bytes | p50 frame | p99 frame |
| --- | --- | --- | --- | --- |
| native | inline | 127 KB | 0.38 ms | 0.89 ms |
| native | split | 269 KB | 0.67 ms | 1.55 ms |
| native | overlay | 128 KB | 0.33 ms | 1.46 ms |
| ink | inline | 263 KB | 9.01 ms | 20.28 ms |
| ink | split | 536 KB | 8.91 ms | 23.25 ms |
| ink | overlay | 260 KB | 7.83 ms | 17.27 ms |
| pi | inline | 172 KB | 0.01 ms | 0.07 ms |

1. **All three run on Bun.** CDA-18's main open risk was `pi-tui`'s declared
   `engines.node >= 22.19.0`. It runs on Bun unmodified, native prebuilds and all. That risk
   is closed, and it is closed for the architecture as much as for the package: the
   string-array design reaches 0.07 ms frames and 172 KB, which is the ceiling to aim at.

2. **Ink misses a 60 fps budget on every layout.** Its p99 frame is 17-23 ms against a 16.7 ms
   budget, 15-25x the in-house renderer. React reconciliation plus Yoga reflow is a fixed cost
   per frame, and a coding agent's defining workload is a high-frequency token stream. Ink is
   weakest exactly where this application spends its time.

3. **Ink cannot composite.** Its `overlay` layout blanks the transcript, because Ink has no
   absolute positioning and a centered flex panel is the closest thing available. The in-house
   renderer draws the approval box over the transcript with the surrounding context still
   readable. Compositing costs it nothing (128 KB vs 127 KB inline).

4. **Ink assumes it owns stdin for the life of the process.** It reads through a `'readable'`
   listener and never calls `resume()`, so on Bun it receives no input at all if another
   component paused stdin first. The spike needed a fresh `tty.ReadStream(0)` to hand Ink a
   clean handle. This is not academic: the agent has to give the terminal to a bash tool and
   take it back.

5. **Neither candidate gives you a scroll viewport.** It is hand-written in both renderers
   here. CDA-18 counted this as Ink's distinctive contribution; it is unavoidable work under
   either approach, so it does not separate them.

6. **Headless testing does not separate them either.** `harness.ts` replays a captured byte
   stream through `@xterm/headless` and asserts on the resulting screen, and that works
   identically for all three. Note that Bun has no PTY, so capturing the stream needs an
   external driver; that is a gap in the Bun testing story, not in any framework.

## Interaction model

Inline is the primary layout. The split rail duplicates what the transcript already says and
costs 2.1x the bytes, so it belongs behind a toggle for long sessions rather than in the
default. Approvals are the one thing worth lifting out of the flow: an overlay keeps the
diff and the surrounding transcript on screen together, and in the in-house renderer it is
free. So: inline transcript, approvals composited over it, split rail opt-in.

## Caveats

`rows-dirty` is only reported by the in-house renderer, since Ink and pi-tui own their own
diffing. pi-tui frame counts come from `render()` calls and are not comparable with the other
two; its byte total is. Cancel latency measures the UI path only, because the scripted session
aborts instantly; a real tool's abort cost is not in that number.
