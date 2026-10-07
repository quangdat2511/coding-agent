# Runtime sibling import check

Run `bun run check:runtime-imports` from the repository root. The CI workflow runs this command
in its own job on pull requests and pushes to `main`.

The check bundles the `ai`, `agent-core`, `tools`, and `tui` entry points with `Bun.build`
(`target: "bun"`), then parses the emitted JavaScript for sibling imports, re-exports, dynamic
imports, and requires (including Bun's `__require` helper). A resolver plugin keeps every bare
specifier external, `@coding-agent/*` included, because bundling third-party code fails on optional
peers that are not installed, such as Ink's `react-devtools-core`. The plugin replaces
`--packages external`, which also externalizes the package's own `#src/` imports; the bundle then
holds every file the entry point reaches, so a sibling import in any of them is caught. An import
starting with `#` left in the bundle also fails the check, because the files behind it were never
inspected.
The `coding-agent` composition root is intentionally excluded. Type-only imports disappear
from the bundles. Build or parse errors also fail the command.

## CDA-38 acceptance demonstration

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
