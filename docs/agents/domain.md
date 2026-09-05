# Domain Docs

How the engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- `CONTEXT-MAP.md` at the repo root.
- The package-level `CONTEXT.md` relevant to the topic, such as `packages/ai/CONTEXT.md`.
- System-wide ADRs in `docs/adr/`.
- Context-specific ADRs in the relevant package's `docs/adr/`.

If any of these files do not exist, proceed silently. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

This is a multi-context monorepo:

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                    # system-wide decisions
└── packages/
    └── <package>/
        ├── CONTEXT.md           # package context
        └── docs/adr/            # package-specific decisions
```

`CONTEXT-MAP.md` points to each package context and explains which context applies to a given area.

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in the relevant `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If the needed concept is not in the glossary, treat that as a signal for `/domain-modeling` rather than inventing terminology.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it:

> _Contradicts ADR-0007 — but worth reopening because…_
