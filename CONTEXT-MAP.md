# Context Map

## Contexts

- [AI](./packages/ai/CONTEXT.md) — represents model interaction independently of any one provider
- [Agent Core](./packages/agent-core/CONTEXT.md) — coordinates one coding task and its controlled actions
- [Terminal UI](./packages/tui/CONTEXT.md) — presents and controls the full-screen terminal experience
- [Coding Agent](./packages/coding-agent/CONTEXT.md) — composes the packages into the user-facing application

## Relationships

- **AI → Agent Core**: AI supplies provider-neutral model interactions used during an Agent Session.
- **Agent Core ↔ Terminal UI**: Agent Core exposes session activity; Terminal UI presents it and
  returns user decisions.
- **Coding Agent → AI, Agent Core, Terminal UI**: Coding Agent composes the three contexts into an
  executable application.

The exact package APIs and dependency direction remain Wayfinder decisions; this map records only
the agreed domain boundaries.
