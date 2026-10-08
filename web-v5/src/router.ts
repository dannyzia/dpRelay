/**
 * Minimal hash router — deliberately hand-rolled (zero extra dependencies)
 * and deliberately hash-based: deep links like `#/operator` must work on ANY
 * static host without SPA rewrite configuration, because the orchestrator
 * provisions the Render static site and a missing rewrite rule would 404 the
 * operator panel. Hash routes never touch the server.
 */
import { useCallback, useEffect, useState } from "react";

/** Parses `location.hash` into segments: "#/operator/billing" → ["operator", "billing"]. */
export function parseHash(hash: string): string[] {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "") return [];
  return raw.split("/").filter((s) => s.length > 0);
}

/** Builds a hash href from segments: ["operator"] → "#/operator". */
export function hrefFor(segments: string[]): string {
  return segments.length === 0 ? "#" : `#/${segments.join("/")}`;
}

/** Current route segments, re-rendered on hashchange. */
export function useRoute(): string[] {
  const [segments, setSegments] = useState<string[]>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setSegments(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return segments;
}

/** Programmatic navigation helper (pushes a hash change). */
export function useNavigate(): (segments: string[]) => void {
  return useCallback((segments: string[]) => {
    window.location.hash = hrefFor(segments);
  }, []);
}
