# Repository checks

## Import boundary check

Run `bun run check:import-boundaries` from the repository root. Lefthook runs it on staged `.ts`
and `.tsx` files; CI runs it with no arguments, which checks every workspace package.

The check reads each `.ts` and `.tsx` file whose nearest `package.json` is a workspace package,
skipping `node_modules` and `dist`, and finds the specifiers of `from` clauses, side-effect imports,
dynamic `import()`, and `require()`. It fails on a `@/`, `@tests/`, or `@examples/` path alias, on a
relative specifier that resolves outside the file's own package, and on a given path that does not
exist. A nested directory with its own `package.json` is not a workspace package, so its files are
not checked. The scan is textual: a matching specifier inside a comment or string also fails, and a
template literal with a `${}` substitution is not checked.

### CDA-99 acceptance demonstration

Temporarily add `packages/tools/src/probe.ts`:

```ts
export type { SessionEvent } from "../../agent-core/src/events.ts";
```

`bun run check:import-boundaries` exits 1 and reports:

```text
packages/tools/src/probe.ts:1: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name
```

Staging the file makes the Lefthook pre-commit hook fail the same way. Delete the file afterwards.

## Runtime sibling import check

Run `bun run check:runtime-imports` from the repository root. The CI workflow runs this command
in its own job on pull requests and pushes to `main`.

The check bundles the `ai`, `agent-core`, `tools`, and `tui` entry points with
`bun build --target bun --packages external --external '@coding-agent/*'`, then parses the emitted
JavaScript for sibling imports, re-exports, dynamic imports, and requires (including Bun's
`__require` helper). `--packages external` leaves third-party imports unbundled, because bundling
them fails on optional peers that are not installed, such as Ink's `react-devtools-core`; relative
imports still resolve to the package's own files, so a sibling import in any of them is caught,
such as a runtime `@coding-agent/ai` import in `packages/tui/src/render.tsx`.
The `coding-agent` composition root is intentionally excluded. Type-only imports disappear
from the bundles. Build or parse errors also fail the command; temporary output is removed.

### CDA-38 acceptance demonstration

Temporarily replace `packages/agent-core/src/index.ts` with:

```ts
import { ProviderDirectory } from "@coding-agent/ai";
export const probe = ProviderDirectory;
```

`bun run check:runtime-imports` exits 1 and reports:

```text
@coding-agent/agent-core: forbidden runtime import: import { ProviderDirectory } from "@coding-agent/ai";
```

Replace it with the same symbol used only as a type:

```ts
import type { ProviderDirectory } from "@coding-agent/ai";
export type Probe = typeof ProviderDirectory;
```

The command exits 0. Restore the entry point after the demonstration.

Also verified: `require("@coding-agent/ai")`, `import("@coding-agent/ai")`, and
`export * from "@coding-agent/ai"` fail when retained in the bundle; exporting the plain string
`"@coding-agent/ai"` passes. These checks inspect reachable emitted code, not unused source imports
or computed module specifiers.
