import type { ToolDeclaration } from "@coding-agent/ai";
import type { Static, TSchema } from "typebox";
import type { ToolError, ToolErrorCode, ToolProgress } from "./tool-result.ts";
import type { RepoPath, WorkspaceResolver } from "./workspace.ts";

export type ToolMutation = "read_only" | "mutating";

export interface PrepareContext {
  readonly workspace: WorkspaceResolver;
  readonly signal: AbortSignal;
}

export interface ExecuteContext extends PrepareContext {
  onProgress(update: ToolProgress): void;
}

export interface PreparedCall<S extends TSchema = TSchema> {
  readonly input: Static<S>;
  readonly paths: readonly RepoPath[];
  readonly summary: string;
}

export type PrepareOutcome<S extends TSchema = TSchema> =
  | { readonly ok: true; readonly prepared: PreparedCall<S> }
  | { readonly ok: false; readonly code: ToolErrorCode; readonly message: string };

export type ToolOutcome =
  | { readonly isError: false; readonly content: string; readonly truncated?: boolean }
  | {
      readonly isError: true;
      readonly content: string;
      readonly error: ToolError;
      readonly truncated?: boolean;
    };

export interface ExecutableTool<S extends TSchema = TSchema> extends ToolDeclaration<S> {
  readonly mutation: ToolMutation;
  prepare(input: Static<S>, ctx: PrepareContext): Promise<PrepareOutcome<S>>;
  execute(prepared: PreparedCall<S>, ctx: ExecuteContext): Promise<ToolOutcome>;
}

export interface ToolRegistry {
  get(name: string): ExecutableTool | undefined;
  list(): readonly ExecutableTool[];
}
