// tsc compiles agent-core and ai with this tsconfig, so this fails if either uses a path alias.
import type { RunEvent } from "@coding-agent/agent-core";

export type ResolvesAgentCoreTypes = RunEvent;
