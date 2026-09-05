# Full-Screen Terminal UI Framework & Architecture Evaluation

**Ticket:** CDA-18  
**Decision Date:** 2026-09-05  
**Context:** Coding Agent MVP  
**Scope:** Architecture and framework selection for the full-screen terminal UI (`@coding-agent/tui`) in a Bun/TypeScript monorepo.

---

## 1. Context & The Academic Dilemma

The project requires a full-screen terminal UI (`@coding-agent/tui`) for an AI coding agent running on Bun, modeled after [Pi](https://github.com/earendil-works/pi).

While Pi provides `@earendil-works/pi-tui`, directly consuming it reduces `@coding-agent/tui` to a trivial wrapper, undermining the engineering ownership and academic depth expected of a capstone project.

This evaluation resolves the core architectural dilemma:
- **Approach A (Re-Engineered In-House TUI)**: Re-implement Pi's battle-tested TUI architecture natively in `@coding-agent/tui`, adapting and customizing it directly to our project's needs on Bun without an external npm dependency.
- **Approach B (Ink + Custom Viewport)**: Adopt the React component model (`ink@7.1.1`) and engineer a custom virtualized, scrollable viewport.

---

## 2. Evaluation Criteria

To evaluate all candidates objectively, seven core criteria were defined around the requirements of an AI coding agent CLI running on Bun:

1. **Academic Contribution & Technology Ownership**: Demonstrates substantial engineering depth and algorithmic problem-solving for the capstone dissertation, rather than merely consuming a pre-packaged dependency.
2. **Architectural Differentiation & Independence**: Maintains a clear technological identity distinct from Pi, avoiding 1:1 code copying or heavy upstream lock-in.
3. **Bun Runtime Compatibility & Packaging**: Native ESM resolution, strict TypeScript compliance (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`), and clean operation on Bun (`node:tty`, `process.stdin` raw mode, `Bun.spawn` PTY support).
4. **Viewport, Scrolling & Transcript Management**: Ability to handle unbounded agent logs and code diffs with automatic follow-to-bottom streaming, mouse/keyboard navigation, and a fixed bottom editor/status footer.
5. **Streaming Rendering Performance**: Differential line diffing and synchronized output (CSI 2026) to prevent flicker during high-frequency token bursts (50–100+ tokens/s).
6. **Implementation Complexity & MVP Schedule Risk**: Does the UI workload remain bounded so it does not derail the core agent deliverables (Planning, Verification, Safety, TerminalBench)?
7. **Automated Headless Testability**: Ability to write deterministic virtual-terminal or component snapshot tests in CI without requiring an interactive physical terminal.

---

## 3. Comprehensive Candidate & Approach Analysis

### Approach A: Re-Engineered In-House TUI (Pi Architecture Tailored for Bun)
*Re-implement Pi's battle-tested TUI design natively in `@coding-agent/tui` and customize it to our project's specific needs.*

- **Technical Concept**:
  Treat Pi's TUI as an architectural reference point rather than a black-box dependency. Re-implement its core mechanics (alternate-screen double buffering, `ScrollView`, differential line diffing, and text editor) directly within `@coding-agent/tui`, while customizing and tailoring it:
  - Optimize natively for Bun's standard TTY stream primitives (`process.stdin`, `process.stdout`).
  - Strip out unnecessary Node legacy shims and dynamic Windows native helpers from upstream.
  - Tailor the component hierarchy, theme, and event-coalescing model specifically to our agent runtime (`@coding-agent/agent-core`).
- **Strengths**:
  - **Full Code Ownership & Customization Freedom**: Eliminates external upstream coupling and version churn. The team has 100% control to customize UI layout, keyboard bindings, and agent status indicators.
  - **De-risked Terminal Foundation**: Instead of building a raw terminal engine in a vacuum, reusing Pi's proven architectural patterns eliminates guesswork around terminal protocols, resize reflow, and raw mode handling.
  - **Optimal Token Streaming Performance**: Retains Pi's direct string-array line rendering (`render(width) -> string[]`), avoiding Virtual DOM diffing overhead during rapid LLM token bursts.
  - **Academic & Engineering Value**: Demonstrates deep understanding and re-engineering of low-level systems programming on Bun for the capstone dissertation.
- **Weaknesses & Risks**:
  - **Porting & Maintenance Effort**: The team is responsible for adapting, maintaining, and testing low-level terminal routines (Unicode width, ANSI parsing, signal teardown).
  - **Moderate Schedule Risk**: Demands more initial engineering effort than consuming a high-level UI library like Ink.

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

## 4. Multi-Criteria Trade-Off Matrix

| Evaluation Criteria | Approach A: Re-Engineered In-House TUI | Approach B: Ink + Custom Viewport | Approach D: Direct `@earendil-works/pi-tui` |
| :--- | :---: | :---: | :---: |
| **1. Academic Contribution** | 🟢 **High**<br>Full code ownership; tailored re-implementation for Bun | 🟢 **High**<br>Solves community-wide Ink scrolling problem | 🔴 **Low**<br>Trivial wrapper; zero code written |
| **2. Architectural Differentiation** | 🟡 **Moderate**<br>Independent codebase, but structurally modeled on Pi | 🟢 **High**<br>Distinct paradigm (Declarative React vs Pi) | 🔴 **None**<br>Direct clone / upstream dependency |
| **3. Bun Native Compatibility** | 🟢 **High**<br>Tailored directly for Bun, zero native binary baggage | 🟢 **High**<br>Standard ESM, runs cleanly on Bun | 🟡 **Limited**<br>Declares `node >=22`, external binary helper |
| **4. Viewport & Scrolling UX** | 🟢 **High**<br>Proven design customized for agent transcript | 🟡 **Trade-off**<br>Requires custom windowing math on Ink | 🟢 **High**<br>Ready out of the box |
| **5. Streaming Performance** | 🟢 **High**<br>Lightweight string arrays, instant diffing | 🟡 **Trade-off**<br>React/Yoga overhead; requires throttling | 🟢 **High**<br>Highly optimized differential rendering |
| **6. Schedule & Implementation Risk** | 🟡 **Moderate Risk**<br>De-risked by Pi's architecture; needs adaptation | 🟢 **Low Risk**<br>Layout handled by Ink, focused scope | 🟢 **Zero Risk**<br>Zero development time |
| **7. Headless Testability** | 🟢 **Strong**<br>`@xterm/headless` integration | 🟢 **Strong**<br>`ink-testing-library` | 🟢 **Strong**<br>Existing test harness |
| **VERDICT / DISPOSITION** | **Shortlisted (Contender 1)**<br>Best for streaming performance & full tailored ownership | **Shortlisted (Contender 2)**<br>Best for architectural identity & rapid UI velocity | **REJECTED FOR PRODUCTION**<br>Reference Baseline only for CDA-17 |

---

## 5. Architectural Recommendation

1. **Rule Out Direct Dependency on `@earendil-works/pi-tui`**:
   The final `@coding-agent/tui` workspace package will be independently implemented by the team, securing academic integrity and technical contribution for the HCMUS capstone defense.
2. **Shortlist the Top Two Contenders**:
   - **Contender 1 (Ink + Custom Scrollable Viewport)**: Offers the highest technological differentiation from Pi, a clean declarative component model, and a clearly defined engineering contribution (building the virtualized scroll viewport).
   - **Contender 2 (Re-Engineered In-House TUI)**: Offers unmatched streaming throughput, zero external dependencies, and complete source code ownership by re-implementing and tailoring Pi's proven design natively for Bun.
3. **Bridge to Prototype Ticket [CDA-17](https://datn-fit-hcmus.atlassian.net/browse/CDA-17)**:
   The ultimate framework selection will be decided empirically through a **Dual-Spike Prototype** in CDA-17.

---

## 6. Primary Sources & Snapshot Notes

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
