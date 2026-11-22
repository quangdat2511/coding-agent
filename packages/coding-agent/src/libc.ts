import { constants } from "node:os";

// musl's loader answers any "libc." name with itself, so this glibc soname works on Alpine too.
export const LIBC = "libc.so.6";

export function describeErrno(code: number): string {
  const name = Object.entries(constants.errno).find(([, value]) => value === code)?.[0];
  return name === undefined ? `errno ${code}` : `errno ${code} (${name})`;
}
