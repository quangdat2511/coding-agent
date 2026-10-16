export type Fields = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null;

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
