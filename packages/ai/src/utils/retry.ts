/**
 * Normalizes the transport retry bound:
 * - Defaults to 0 when omitted, undefined, null, or non-finite (e.g. NaN, Infinity).
 * - Clamps negative numbers to 0.
 * - Truncates floating-point numbers to integers.
 */
export function sanitizeMaxRetries(maxRetries?: number): number {
  if (typeof maxRetries !== "number" || !Number.isFinite(maxRetries)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxRetries));
}
