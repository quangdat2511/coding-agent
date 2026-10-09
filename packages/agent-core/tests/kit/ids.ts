import type { IdKind, IdSource } from "../../src/index.ts";

export function sequentialIds(): IdSource {
  const issued = new Map<IdKind, number>();

  return {
    next(kind) {
      const count = (issued.get(kind) ?? 0) + 1;
      issued.set(kind, count);
      return `${kind}-${count}`;
    },
  };
}
