# Full-Screen Terminal UI Framework & Architecture Evaluation

**Ticket:** CDA-18  
**Decision Date:** 2026-09-05  
**Context:** Capstone Project (Đồ án tốt nghiệp, HCMUS) — Coding Agent MVP  
**Scope:** Architecture and framework selection for the full-screen terminal UI (`@coding-agent/tui`) in a Bun/TypeScript monorepo.

---

## 1. Context & The Academic Dilemma

This project is modeled on [Pi](https://github.com/earendil-works/pi) (`earendil-works/pi`) and adopts a modular monorepo architecture with four planned packages: `@coding-agent/ai`, `@coding-agent/agent-core`, `@coding-agent/tui`, and `@coding-agent/coding-agent`.

As a university final-year capstone project, technical contribution, architectural independence, and engineering ownership are essential evaluation metrics. Pi provides a standalone package, `@earendil-works/pi-tui@0.84.2`. However:

> [!IMPORTANT]
> Simply installing and importing `@earendil-works/pi-tui` from npm leaves almost no engineering work in `@coding-agent/tui`—reducing the package to a trivial wrapper. This undermines the academic value of the capstone project and creates direct external coupling to Pi's upstream release cycle.

Consequently, this evaluation investigates the foundational architectural dilemma:
**Should the team build an in-house Micro-TUI engine inspired by Pi's core principles, or should the project adopt an alternative framework such as `Ink` (React-based) with a custom scrollable viewport?**

---

## 2. Evaluation Criteria

To evaluate all candidates objectively, seven core criteria were defined around the requirements of an AI coding agent CLI running on Bun:

1. **Academic Contribution & Technology Ownership (Weight: 25%)**: Does the approach demonstrate substantial engineering depth and algorithmic problem-solving for the capstone dissertation, rather than merely consuming a pre-packaged dependency?
2. **Architectural Differentiation & Independence (Weight: 20%)**: Does the design maintain a clear technological identity distinct from Pi, avoiding 1:1 code copying or heavy upstream lock-in?
3. **Bun Runtime Compatibility & Packaging (Weight: 15%)**: Native ESM resolution, strict TypeScript compliance (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`), and clean operation on Bun (`node:tty`, `process.stdin` raw mode, `Bun.spawn` PTY support).
4. **Viewport, Scrolling & Transcript Management (Weight: 15%)**: Ability to handle unbounded agent logs and code diffs with automatic follow-to-bottom streaming, mouse/keyboard navigation, and a fixed bottom editor/status footer.
5. **Streaming Rendering Performance (Weight: 10%)**: Differential line diffing and synchronized output (CSI 2026) to prevent flicker during high-frequency token bursts (50–100+ tokens/s).
6. **Implementation Complexity & MVP Schedule Risk (Weight: 10%)**: Does the UI workload remain bounded so it does not derail the core agent deliverables (Planning, Verification, Safety, TerminalBench)?
7. **Automated Headless Testability (Weight: 5%)**: Ability to write deterministic virtual-terminal or component snapshot tests in CI without requiring an interactive physical terminal.

---

## 3. Comprehensive Candidate & Approach Analysis

### Approach A: In-House Micro-TUI Engine (Pi Principles)
*Build an independent, minimalist terminal engine in `@coding-agent/tui` implementing Pi's core rendering principles.*

- **Technical Concept**:
  Develop a lean terminal engine from scratch using Bun/Node standard TTY primitives (`process.stdin`, `process.stdout`), ANSI escape sequences (`\x1b[?1049h` for alternate screen), differential line diffing, a dedicated `ScrollView` buffer, and an input editor.
- **Strengths**:
  - **Highest Academic & System Engineering Value**: The team demonstrates full mastery of low-level terminal protocols, buffer management, differential frame rendering, and cursor synchronization.
  - **Zero External Dependencies & Bun-Native**: 100% written in TypeScript for Bun. No reliance on Node-specific native binaries or legacy compatibility layers.
  - **Optimal Token Streaming Performance**: Direct string-array line rendering (`render(width) -> string[]`) avoids virtual DOM diffing and Yoga layout recalculation, providing minimal CPU/memory overhead during rapid LLM token generation.
  - **Deterministic Headless Testing**: Directly testable via `@xterm/headless`, enabling automated visual regression tests in CI.
- **Weaknesses & Risks**:
  - **High Implementation Effort**: Requires manual handling of tricky terminal edge cases: multi-byte UTF-8 / CJK character width calculation, ANSI escape strip/wrap arithmetic, terminal resize reflow, and raw-mode teardown on abnormal process termination.
  - **Schedule Risk**: Deep low-level bug fixing could consume bandwidth needed for core agent runtime and evaluation logic.

---

### Approach B: Ink Framework (`ink@7.1.1`) + Custom Scrollable Viewport
*Adopt the industry-standard React-based CLI framework and engineer a custom scrollable windowing viewport.*

- **Technical Concept**:
  Leverage React 18+ declarative components, hooks (`useState`, `useEffect`, `useInput`), and Yoga flexbox layout via Ink, while custom-building the missing core component: a `<ScrollableViewport>` / `<VirtualWindow>` for alternate screen streaming.
- **Strengths**:
  - **Clear Architectural Differentiation**: Replaces Pi's imperative string-array model with a modern Declarative React component tree (`<Box>`, `<Text>`, `<Transform>`). This clearly establishes the project as an independent architectural branch rather than a Pi clone.
  - **High-Value Technical Contribution**: Ink does not include a native scrollable viewport for alternate-buffer mode (open feature request [vadimdemedes/ink#773](https://github.com/vadimdemedes/ink/issues/773)). Designing and implementing a virtualized, scrollable transcript component for Ink represents an impressive and tangible engineering contribution for the capstone defense.
  - **Rich Component Ecosystem**: Ready access to mature UI components (e.g., `ink-spinner`, syntax highlighters, select inputs) accelerates polished UI development.
  - **Superb Testing Utilities**: `ink-testing-library` provides first-class headless testing with `render()` and `lastFrame()` assertions.
- **Weaknesses & Risks**:
  - **Reconciliation & Layout Overhead**: React's virtual DOM reconciliation combined with Yoga flexbox reflows adds compute overhead during high-speed token bursts; requires render throttling (e.g., 30–60 FPS bounding).
  - **Complex Windowing Mathematics**: Building a robust virtualized scroll viewport on top of React state requires careful handling of line breaking and cursor positioning.

---

### Approach C: Legacy Full-Screen Frameworks (Rejected)

#### 1. Blessed / Neo-Blessed (`blessed@0.1.81`, `neo-blessed@0.2.0`) — **REJECT**
- **Rationale**: Completely abandoned upstream (no commits on Blessed since January 2016). Codebase is legacy CommonJS with prototype monkey-patching and lacks official TypeScript definitions. High probability of runtime stream incompatibilities with Bun. Zero pedagogical or academic value in adopting decade-old abandonware.

#### 2. Terminal Kit (`terminal-kit@3.1.4`) — **REJECT**
- **Rationale**: A low-level procedural toolkit rather than a component UI framework. Lacks a reactive state or component model, and ships without first-party TypeScript typings. Using Terminal Kit would require building a custom UI layer on top of legacy CommonJS primitives, combining the disadvantages of both approaches without the benefits of either.

---

### Approach D: Pre-Built `@earendil-works/pi-tui@0.84.2` (Reference Baseline Only)

- **Production Evaluation**: **REJECTED FOR FINAL DELIVERY**.
- **Role in Project**: Used exclusively as a **Reference Baseline** during the initial prototyping spike in CDA-17. It provides a benchmark for expected scrolling ergonomics, keyboard navigation, and differential rendering against which our self-developed implementation (Approach A or B) will be measured.

---

## 4. Multi-Criteria Decision Matrix

| Evaluation Criteria | Weight | Approach A: In-House Micro-TUI | Approach B: Ink + Custom Viewport | Approach D: Direct `@earendil-works/pi-tui` |
| :--- | :---: | :---: | :---: | :---: |
| **1. Academic Contribution** | 25% | **5.0 / 5.0**<br>Full ownership of low-level rendering engine | **4.5 / 5.0**<br>Solves community-wide Ink scrolling problem | **1.0 / 5.0**<br>Trivial wrapper; zero code written |
| **2. Architectural Differentiation** | 20% | **4.0 / 5.0**<br>Original code, but architecture mirrors Pi | **5.0 / 5.0**<br>Completely distinct paradigm (React vs Pi) | **1.5 / 5.0**<br>Direct clone / upstream dependency |
| **3. Bun Native Compatibility** | 15% | **5.0 / 5.0**<br>Native TS/Bun, zero dependencies | **4.5 / 5.0**<br>Standard ESM, runs cleanly on Bun | **3.0 / 5.0**<br>Declares `node >=22`, external binary helper |
| **4. Viewport & Scrolling UX** | 15% | **5.0 / 5.0**<br>Designed specifically for agent transcript | **3.5 / 5.0**<br>Requires custom windowing math on Ink | **5.0 / 5.0**<br>Ready out of the box |
| **5. Streaming Performance** | 10% | **5.0 / 5.0**<br>Lightweight string arrays, instant diffing | **3.5 / 5.0**<br>React/Yoga overhead; requires throttling | **5.0 / 5.0**<br>Highly optimized differential rendering |
| **6. Schedule & Implementation Risk** | 10% | **2.5 / 5.0**<br>Heavy terminal edge-case burden | **4.5 / 5.0**<br>Layout handled by Ink, focused scope | **5.0 / 5.0**<br>Zero development time |
| **7. Headless Testability** | 5% | **4.5 / 5.0**<br>`@xterm/headless` integration | **5.0 / 5.0**<br>`ink-testing-library` | **4.5 / 5.0**<br>Existing test harness |
| **WEIGHTED TOTAL SCORE** | **100%** | **4.25 / 5.0** 🥈 | **4.33 / 5.0** 🏆 | **2.65 / 5.0** ❌ |

---

## 5. Architectural Recommendation

1. **Rule Out Direct Dependency on `@earendil-works/pi-tui`**:
   The final `@coding-agent/tui` workspace package will be independently implemented by the team, securing academic integrity and technical contribution for the HCMUS capstone defense.
2. **Shortlist the Top Two Contenders**:
   - **Contender 1 (Ink + Custom Scrollable Viewport)**: Offers the highest technological differentiation from Pi, a clean declarative component model, and a clearly defined engineering contribution (building the virtualized scroll viewport).
   - **Contender 2 (In-House Micro-TUI)**: Offers unmatched streaming throughput, zero dependencies, and complete low-level control.
3. **Bridge to Prototype Ticket [CDA-17](https://datn-fit-hcmus.atlassian.net/browse/CDA-17)**:
   The ultimate framework selection will be decided empirically through a **Dual-Spike Prototype** in CDA-17.

---

## 6. Validation Spike Plan for CDA-17

During ticket CDA-17 (`wayfinder:prototype`), the team will execute a focused, 2-day technical spike across both shortlisted contenders:

### Spike 1: Ink + Custom Scrollable Viewport Prototype
- Build a minimal alternate-screen layout using `ink@7.1.1` with `alternateScreen: true`.
- Implement a prototype `<ScrollableViewport>` component that:
  - Consumes a stream of 1,000 synthetic token deltas and tool-call blocks.
  - Maintains follow-to-bottom auto-scroll during active generation.
  - Allows manual scrolling (PageUp / PageDown / Up / Down) without breaking line boundaries.
  - Keeps an interactive input prompt pinned to the bottom.
- Measure render latency, frame rate consistency, and CPU consumption under high token throughput.

### Spike 2: In-House Micro-TUI Prototype
- Implement a minimal 3-file engine:
  - `terminal.ts`: Alternate buffer entry/exit, raw mode configuration, ANSI reset hooks.
  - `renderer.ts`: Basic differential line diffing with double buffering.
  - `scroll-view.ts`: Simple string buffer slicing and scroll offset management.
- Test terminal signal handling (`SIGINT`), window resize (`SIGWINCH`), and exit cleanup.

### Decision Criteria for CDA-17 Selection:
- If the Ink prototype successfully handles rapid token bursts (≥60 tokens/s without visible lag or dropped frames) and the custom viewport logic remains clean and maintainable (≤250 lines), **Ink will be officially selected** for its superior architecture and React DX.
- If Ink suffers from perceptible frame stutters or layout thrashing during token bursts, **the In-House Micro-TUI will be selected**, leveraging its deterministic string-array diffing performance.
