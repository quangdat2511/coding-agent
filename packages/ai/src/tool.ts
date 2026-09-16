import type { TSchema } from "typebox";

export interface ToolDeclaration<S extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
}
