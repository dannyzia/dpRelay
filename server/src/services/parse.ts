/**
 * Trust-boundary narrowing helpers shared by route modules. Every untyped JSON
 * body field passes through one of these before use (PLAN §5 — validate at the
 * boundary, never trust input).
 */

/** Narrows unknown JSON to a plain record, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Narrows unknown to a non-empty string of at most `maxLen` characters, or null. */
export function asString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    return null;
  }
  return value;
}
