# Context Map

## Contexts

- [AI](./packages/ai/CONTEXT.md) — represents model interaction independently of any one provider
- [Agent Core](./packages/agent-core/CONTEXT.md) — coordinates one coding task and its controlled actions
- [Tools](./packages/tools/CONTEXT.md) — performs the filesystem and process work behind Agent Core's tools
- [Terminal UI](./packages/tui/CONTEXT.md) — presents and controls the full-screen terminal experience
- [Coding Agent](./packages/coding-agent/CONTEXT.md) — composes the packages into the user-facing application

## Relationships

- **AI → Agent Core**: AI supplies provider-neutral model interactions used during an Agent Run.
- **Tools → Agent Core**: Tools implements the tool and workspace ports that Agent Core defines and
  invokes.
- **Agent Core ↔ Terminal UI**: Agent Core exposes Agent Run activity; Terminal UI presents it
  within a Session and returns the person's Actions. Coding Agent's Session Controller carries both
  directions, so neither package depends on the other.
- **Coding Agent → AI, Agent Core, Tools, Terminal UI**: Coding Agent composes the four contexts into
  an executable application.

Package APIs and dependency direction are defined in
[Package APIs and Dependency Direction](./docs/adr/0004-package-apis-and-dependency-direction.md).
