/**
 * Pure hash-route helpers — deliberately hand-rolled (zero extra
 * dependencies) and deliberately hash-based: deep links like `#/operator`
 * must work on ANY static host without SPA rewrite configuration, because
 * the orchestrator provisions the Render static site and a missing rewrite
 * rule would 404 the operator panel. Hash routes never touch the server.
 *
 * STAGE F9 → ISSUE-91 (frontend standard): the pure functions live in
 * `lib/` so tests and the shell import them without pulling React; the
 * stateful hooks live in `src/hooks/useRoute.ts`.
 */

/** Parses `location.hash` into segments: `"#/operator/billing"` → `["operator", "billing"]`. */
export function parseHash(hash: string): string[] {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "") return [];
  return raw.split("/").filter((s) => s.length > 0);
}

/** Builds a hash href from segments: `["operator"]` → `"#/operator"`. */
export function hrefFor(segments: string[]): string {
  return segments.length === 0 ? "#" : `#/${segments.join("/")}`;
}
