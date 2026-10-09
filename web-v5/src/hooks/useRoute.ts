/**
 * Stateful hash-router hooks (ISSUE-91: hooks live in `src/hooks/`).
 * The pure helpers they build on are `src/lib/router.ts`.
 */
import { useCallback, useEffect, useState } from "react";
import { hrefFor, parseHash } from "../lib/router";

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
