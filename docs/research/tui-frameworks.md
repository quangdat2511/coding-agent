# Full-Screen TUI Architecture & Evaluation

**Ticket:** [CDA-18](https://datn-fit-hcmus.atlassian.net/browse/CDA-18)  
**Decision Date:** 2026-09-05  
**Context:** Capstone Project (Đồ án tốt nghiệp, HCMUS) — Coding Agent MVP  
**Scope:** Architecture and candidate evaluation for the Full-screen TUI (`@coding-agent/tui`) in a Bun/TypeScript monorepo.

---

## 1. Context & The Academic Dilemma

This project is modeled on [Pi](https://github.com/earendil-works/pi) (`earendil-works/pi`) and adopts a modular monorepo architecture with four planned packages: `@coding-agent/ai`, `@coding-agent/agent-core`, `@coding-agent/tui`, and `@coding-agent/coding-agent`.

As a university final-year capstone project, technical contribution, architectural independence, and engineering ownership are essential evaluation metrics. Pi provides a standalone package, `@earendil-works/pi-tui@0.84.2`. However:

> [!IMPORTANT]
> Simply installing and importing `@earendil-works/pi-tui` from npm leaves almost no engineering work in `@coding-agent/tui`—reducing the package to a trivial wrapper. This undermines the academic value of the capstone project and creates direct external coupling to Pi's upstream release cycle.

Consequently, this evaluation investigates the foundational architectural dilemma:
**Should the team build an in-house Full-screen TUI engine inspired by Pi's core principles, or should the project adopt an alternative framework such as `Ink` (React-based) combined with a custom-engineered scrollable viewport?**

---

## 2. Evaluation Criteria

To evaluate all candidates objectively and satisfy all requirements of [CDA-18](https://datn-fit-hcmus.atlassian.net/browse/CDA-18), eight core criteria were defined around the needs of an AI coding agent running on Bun:

1. **Academic Contribution & Engineering Ownership (Weight: 20%)**: Does the approach demonstrate substantial engineering depth and algorithmic problem-solving for the capstone dissertation, rather than merely consuming a pre-packaged dependency?
2. **Architectural Differentiation & Independence (Weight: 15%)**: Does the design maintain a clear technological identity distinct from Pi, avoiding 1:1 code copying or heavy upstream lock-in?
3. **Bun Runtime Compatibility & Packaging (Weight: 15%)**: Native ESM resolution, strict TypeScript compliance (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`), and clean operation on Bun (`node:tty`, `process.stdin` raw mode, `Bun.spawn` PTY support).
4. **Viewport, Scrolling & Transcript Management (Weight: 15%)**: Ability to handle unbounded agent logs and code diffs with automatic follow-to-bottom streaming, mouse/keyboard navigation, and a fixed bottom editor/status footer.
5. **Input, Editor & Keyboard Protocol Handling (Weight: 10%)**: Support for interactive prompt input (single-line and multi-line), cursor navigation, history management, bracketed paste mode, raw stdin byte decoding, and modern terminal keyboard protocols (e.g. Kitty keyboard protocol).
6. **Streaming Rendering Performance (Weight: 10%)**: Differential line diffing and synchronized output (CSI 2026) to prevent flicker during high-frequency token bursts (50–100+ tokens/s).
7. **Implementation Complexity & Schedule Risk (Weight: 10%)**: Does the UI workload remain bounded so it does not derail the core agent deliverables (Planning, Verification, Safety, TerminalBench)?
8. **Automated Headless Testability (Weight: 5%)**: Ability to write deterministic virtual-terminal or component snapshot tests in CI without requiring an interactive physical terminal.

---

## 3. Comprehensive Candidate & Approach Analysis

### Approach A: In-House Micro-TUI Engine (Pi Principles)
*Build an independent, minimalist terminal engine in `@coding-agent/tui` implementing Pi's core rendering principles.*

- **Technical Concept**:
  Develop a lean terminal engine from scratch using Bun/Node standard TTY primitives (`process.stdin`, `process.stdout`), ANSI escape sequences (`\x1b[?1049h` for alternate screen), differential line diffing, a dedicated `ScrollView` buffer, and an input editor.
- **Rendering & Viewport**:
  Implements an alternate-screen buffer with double-buffering line diffs (`render(width) -> string[]`). Full control over the transcript viewport, rewrapping text on terminal resize, and pinning the prompt at the bottom.
- **Input, Editor & Keyboard Handling**:
  Requires implementing a custom multiline text editor buffer managing cursor row/column coordinates, backspace/delete, word wrapping, horizontal scrolling for long lines, and history navigation. Keyboard handling requires parsing raw stdin byte streams, decoding ANSI escape sequences (arrows, Home/End, PgUp/PgDn), supporting bracketed paste mode (`\x1b[?2004h/l`), and optionally negotiating Kitty keyboard protocol (`\x1b[>1u`).
- **Strengths**:
  - **Highest Academic & Systems Value**: Demonstrates mastery of low-level terminal protocols, buffer management, differential frame rendering, and cursor synchronization.
  - **Zero External Dependencies & Bun-Native**: 100% written in TypeScript for Bun. No reliance on Node-specific native binaries or legacy compatibility layers.
  - **Optimal Token Streaming Performance**: Direct string-array line rendering avoids virtual DOM diffing and Yoga layout recalculation, providing minimal CPU/memory overhead during rapid LLM token generation.
  - **Deterministic Headless Testing**: Directly testable via `@xterm/headless`, enabling automated visual regression tests in CI.
- **Weaknesses & Risks**:
  - **High Implementation Complexity**: Developing a robust multiline editor, handling Unicode/CJK character widths (`wcwidth`), and managing edge-case ANSI escape sequences require significant engineering time.
  - **Schedule Risk**: Low-level terminal debugging could consume bandwidth needed for core agent runtime and evaluation logic.

---

### Approach B: Ink Framework (`ink@7.1.1`) + Custom Scrollable Viewport
*Adopt the industry-standard React-based CLI framework and engineer a custom scrollable windowing viewport.*

- **Technical Concept**:
  Leverage React 18+ declarative components, hooks (`useState`, `useEffect`, `useInput`), and Yoga flexbox layout via Ink, while custom-building the missing core component: a `<ScrollableViewport>` / `<VirtualWindow>` for alternate-screen streaming.
- **Rendering & Viewport**:
  Ink renders to full-screen alternate buffer via `alternateScreen: true`. However, Ink lacks a native virtualized scroll container ([vadimdemedes/ink#773](https://github.com/vadimdemedes/ink/issues/773)). The team would design a custom windowing component that slices a virtual transcript into visible terminal rows based on scroll offset.
- **Input, Editor & Keyboard Handling**:
  Ink provides the `useInput` hook for keypress events with normalized flags (`key.return`, `key.ctrl`, `key.pageDown`). Basic input is available via ecosystem components like `ink-text-input`. However, multi-line editing, undo/redo, and advanced terminal protocols (Kitty keyboard protocol) require custom component state management.
- **Strengths**:
  - **Clear Architectural Differentiation**: Replaces Pi's imperative string-array model with a modern Declarative React component tree (`<Box>`, `<Text>`, `<Transform>`), establishing an independent architectural identity.
  - **High-Value Engineering Contribution**: Solving the long-standing missing scrollable viewport problem in Ink ([vadimdemedes/ink#773](https://github.com/vadimdemedes/ink/issues/773)) provides an impressive and tangible contribution for the capstone dissertation.
  - **Rich Component Ecosystem**: Access to components (spinners, syntax highlighters, select inputs) accelerates UI development.
  - **Superb Testing Utilities**: `ink-testing-library` provides first-class headless testing with `render()` and `lastFrame()` assertions.
- **Weaknesses & Risks**:
  - **Reconciliation & Layout Overhead**: React virtual DOM reconciliation combined with Yoga flexbox reflows adds compute overhead during high-speed token bursts; requires render throttling (e.g. 30–60 FPS bounding).
  - **Windowing Mathematics**: Building a robust virtualized scroll viewport on top of React state requires careful handling of line breaking and cursor positioning.

---

### Approach C: Legacy Full-Screen Frameworks (Rejected)

#### 1. Blessed / Neo-Blessed (`blessed@0.1.81`, `neo-blessed@0.2.0`) — **REJECT**
- **Rationale**: Completely abandoned upstream (no commits on Blessed since January 2016). Codebase is legacy CommonJS with prototype monkey-patching and lacks official TypeScript definitions. While it provides `blessed.textarea` and `blessed.box` with scrolling, it has high probability of stream incompatibilities with Bun. Zero pedagogical or academic value in adopting decade-old abandonware.

#### 2. Terminal Kit (`terminal-kit@3.1.4`) — **REJECT**
- **Rationale**: A low-level procedural toolkit rather than a component UI framework. Lacks a reactive state or component model, and ships without first-party TypeScript typings. While it features `term.inputField()` and `ScreenBuffer`, using Terminal Kit would require building a custom UI layer on top of legacy CommonJS primitives, combining the disadvantages of both approaches without modern benefits.

---

### Approach D: Pre-Built `@earendil-works/pi-tui@0.84.2` (Reference Baseline Only)

- **Technical Concept**:
  Pi's official terminal UI package. Features `ProcessTerminal`, `TuiAltScreen`, `ScrollView`, and an `Editor` component with Kitty keyboard protocol, bracketed paste, and differential rendering.
- **Production Evaluation**: **REJECTED FOR FINAL DELIVERY**.
- **Role in Project**: Used exclusively as a **Reference Baseline** during the initial prototyping spike in CDA-17. It provides an empirical benchmark for scrolling ergonomics, keyboard navigation, and differential rendering against which our self-developed implementation (Approach A or B) will be measured.

---

## 4. Multi-Criteria Decision Matrix

| Evaluation Criteria | Weight | Approach A: In-House Micro-TUI | Approach B: Ink + Custom Viewport | Approach D: Direct `@earendil-works/pi-tui` |
| :--- | :---: | :---: | :---: | :---: |
| **1. Academic Contribution** | 20% | **5.0 / 5.0**<br>Full ownership of low-level rendering engine | **4.5 / 5.0**<br>Solves community-wide Ink scrolling problem | **1.0 / 5.0**<br>Trivial wrapper; zero code written |
| **2. Architectural Differentiation** | 15% | **4.0 / 5.0**<br>Original code, but architecture mirrors Pi | **5.0 / 5.0**<br>Completely distinct paradigm (React vs Pi) | **1.5 / 5.0**<br>Direct clone / upstream dependency |
| **3. Bun Native Compatibility** | 15% | **5.0 / 5.0**<br>Native TS/Bun, zero dependencies | **4.5 / 5.0**<br>Standard ESM, runs cleanly on Bun | **3.0 / 5.0**<br>Declares `node >=22`, external binary helper |
| **4. Viewport & Scrolling UX** | 15% | **5.0 / 5.0**<br>Designed specifically for agent transcript | **3.5 / 5.0**<br>Requires custom windowing math on Ink | **5.0 / 5.0**<br>Ready out of the box |
| **5. Input / Editor & Keyboard** | 10% | **3.5 / 5.0**<br>Must build multiline buffer & key parser | **4.0 / 5.0**<br>`useInput` and `ink-text-input` ecosystem | **5.0 / 5.0**<br>Built-in Editor & Kitty protocol |
| **6. Streaming Performance** | 10% | **5.0 / 5.0**<br>Lightweight string arrays, instant diffing | **3.5 / 5.0**<br>React/Yoga overhead; requires throttling | **5.0 / 5.0**<br>Highly optimized differential rendering |
| **7. Implementation & Schedule Risk**| 10% | **2.5 / 5.0**<br>Heavy terminal edge-case burden | **4.5 / 5.0**<br>Layout handled by Ink, focused scope | **5.0 / 5.0**<br>Zero development time |
| **8. Headless Testability** | 5% | **4.5 / 5.0**<br>`@xterm/headless` integration | **5.0 / 5.0**<br>`ink-testing-library` | **4.5 / 5.0**<br>Existing test harness |
| **WEIGHTED TOTAL SCORE** | **100%** | **4.43 / 5.0** 🥇 | **4.30 / 5.0** 🥈 | **3.35 / 5.0** ❌ |

### Detailed Calculation Breakdown:
- **Approach A (In-House Micro-TUI)**:  
  $(5.0 \times 0.20) + (4.0 \times 0.15) + (5.0 \times 0.15) + (5.0 \times 0.15) + (3.5 \times 0.10) + (5.0 \times 0.10) + (2.5 \times 0.10) + (4.5 \times 0.05)$  
  $= 1.00 + 0.60 + 0.75 + 0.75 + 0.35 + 0.50 + 0.25 + 0.225 = \mathbf{4.425} \approx \mathbf{4.43}$
- **Approach B (Ink + Custom Viewport)**:  
  $(4.5 \times 0.20) + (5.0 \times 0.15) + (4.5 \times 0.15) + (3.5 \times 0.15) + (4.0 \times 0.10) + (3.5 \times 0.10) + (4.5 \times 0.10) + (5.0 \times 0.05)$  
  $= 0.90 + 0.75 + 0.675 + 0.525 + 0.40 + 0.35 + 0.45 + 0.25 = \mathbf{4.300} = \mathbf{4.30}$
- **Approach D (Direct `@earendil-works/pi-tui`)**:  
  $(1.0 \times 0.20) + (1.5 \times 0.15) + (3.0 \times 0.15) + (5.0 \times 0.15) + (5.0 \times 0.10) + (5.0 \times 0.10) + (5.0 \times 0.10) + (4.5 \times 0.05)$  
  $= 0.20 + 0.225 + 0.45 + 0.75 + 0.50 + 0.50 + 0.50 + 0.225 = \mathbf{3.350} = \mathbf{3.35}$

---

## 5. Architectural Recommendation

1. **Rule Out Direct Dependency on `@earendil-works/pi-tui`**:
   The final `@coding-agent/tui` workspace package will be independently implemented by the team, securing academic integrity and technical contribution for the HCMUS capstone defense.
2. **Shortlist the Top Two Contenders**:
   - **Approach A (In-House Micro-TUI)**: Scored **4.43 / 5.0**. Demonstrates unbeatable streaming throughput, zero dependencies, and complete low-level control, but carries higher implementation risk in terminal edge cases.
   - **Approach B (Ink + Custom Scrollable Viewport)**: Scored **4.30 / 5.0**. Demonstrates maximum architectural differentiation from Pi, a clean declarative component model, and a focused contribution in solving virtualized scrolling.
3. **Bridge to Prototype Ticket [CDA-17](https://datn-fit-hcmus.atlassian.net/browse/CDA-17)**:
   Because the scores are tightly matched and represent fundamentally different engineering trade-offs (Systems Engineering vs. Component Architecture), the final selection will be decided empirically through a **Dual-Spike Prototype** in CDA-17.

---

## 6. Prototyping Spike Plan for CDA-17

During ticket [CDA-17](https://datn-fit-hcmus.atlassian.net/browse/CDA-17) (`wayfinder:prototype`), the team will execute a focused technical spike across both shortlisted contenders:

### Spike 1: Ink + Custom Scrollable Viewport Prototype
- Build an alternate-screen layout using `ink@7.1.1` with `alternateScreen: true`.
- Implement a prototype `<ScrollableViewport>` component to evaluate:
  - Streaming token throughput under high-frequency updates (bursts of synthetic tokens).
  - Smooth follow-to-bottom auto-scroll during active generation.
  - Manual scroll navigation (PageUp / PageDown / Up / Down) across wrapped lines.
  - Pinned interactive input prompt at the bottom.
- Observe render latency, frame rate consistency, and CPU consumption under load.

### Spike 2: In-House Micro-TUI Prototype
- Implement a minimal 3-file engine:
  - `terminal.ts`: Alternate buffer entry/exit, raw mode configuration, ANSI reset hooks.
  - `renderer.ts`: Basic differential line diffing with double buffering.
  - `scroll-view.ts`: Simple string buffer slicing and scroll offset management.
- Test terminal signal handling (`SIGINT`), window resize (`SIGWINCH`), and clean exit recovery.

### Comparative Evaluation Metrics:
- **Streaming Smoothness**: Does Ink maintain fluid rendering without visible layout jitter during rapid token emission, or does Micro-TUI's deterministic string diffing provide noticeably superior responsiveness?
- **Code Maintainability**: Is the custom viewport logic in Ink sufficiently clean and robust, or does working within React/Yoga's layout constraints add excessive complexity compared to direct terminal array manipulation?

---

## 7. Primary Sources & Snapshot Notes

All candidate claims, package metadata, and compatibility constraints above were validated against first-party sources:

- **Ink**:
  - Repository & API: [vadimdemedes/ink](https://github.com/vadimdemedes/ink)
  - Package metadata: [vadimdemedes/ink/package.json](https://raw.githubusercontent.com/vadimdemedes/ink/master/package.json)
  - Testing library: [vadimdemedes/ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)
  - Viewport scrolling issue: [vadimdemedes/ink#773](https://github.com/vadimdemedes/ink/issues/773)
  - Release & commit history: [vadimdemedes/ink commits](https://github.com/vadimdemedes/ink/commits/master)
- **Blessed & Neo-Blessed**:
  - Blessed repository: [chjj/blessed](https://github.com/chjj/blessed)
  - Blessed package metadata: [chjj/blessed/package.json](https://raw.githubusercontent.com/chjj/blessed/master/package.json)
  - Neo-Blessed package metadata: [blessedjs/neo-blessed/package.json](https://raw.githubusercontent.com/blessedjs/neo-blessed/master/package.json)
- **Terminal Kit**:
  - Repository: [cronvel/terminal-kit](https://github.com/cronvel/terminal-kit)
  - Package metadata: [cronvel/terminal-kit/package.json](https://raw.githubusercontent.com/cronvel/terminal-kit/master/package.json)
  - High-level API & ScreenBuffer: [terminal-kit high-level doc](https://github.com/cronvel/terminal-kit/blob/master/doc/high-level.md)
- **Pi TUI Reference**:
  - Repository: [earendil-works/pi](https://github.com/earendil-works/pi)
  - Package source: [packages/tui](https://github.com/earendil-works/pi/tree/main/packages/tui)
  - Terminal implementation: [terminal.ts](https://github.com/earendil-works/pi/blob/main/packages/tui/src/terminal.ts)
- **Bun Runtime & Headless Testing**:
  - Bun Node compatibility (`node:tty`): [bun.sh/docs/runtime/nodejs-compat](https://bun.sh/docs/runtime/nodejs-compat)
  - Bun child process & PTY support: [bun.sh/docs/runtime/child-process#terminal-support](https://bun.sh/docs/runtime/child-process#terminal-support)
  - Headless terminal emulation: [xtermjs/xterm.js (@xterm/headless)](https://github.com/xtermjs/xterm.js)
