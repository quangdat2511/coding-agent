// Drops what an Evaluation Profile selects, so two runs under different profiles compare equal
// when nothing else differs (ADR 0005 §5).
export const withoutProfile = <T extends { readonly profile: unknown; readonly limits: unknown }>({
  profile: _,
  limits: __,
  ...rest
}: T): Omit<T, "profile" | "limits"> => rest;
