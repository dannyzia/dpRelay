/**
 * Shared temp-directory tracker for the server test suite (ISSUE-50).
 *
 * Why this exists: every test file called `mkdtempSync` itself and most only
 * closed the app, never `rmSync`-ing the directory — one leaked directory per
 * test (~1 MB per file per run; 9.4k dirs / 5 GB on the build machine, and 41
 * ENOSPC test failures when `/` filled). Directories registered here are
 * removed by the suite's own hooks: after EVERY test — vitest runs
 * `afterEach` even when the test throws, which is ISSUE-50 AC3 — except
 * directories created during collection or `beforeAll`, which must outlive
 * the tests that share them and are removed in `afterAll`.
 *
 * Phase tracking matters: a directory created at module scope (collection) is
 * referenced by every test in the file, so deleting it after the first test
 * would break the rest; it is drained when the file finishes instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

type Phase = "collection" | "test";

/** Which phase created each dir: collection dirs live until afterAll. */
const created: { dir: string; phase: Phase }[] = [];
let phase: Phase = "collection";

/**
 * Create a temp directory under `os.tmpdir()` that is tracked for automatic
 * removal — use INSTEAD OF raw `mkdtempSync` anywhere tests need scratch space.
 *
 * @param prefix directory name prefix, e.g. `"dprelay-billing-test-"`.
 * @returns the created directory path.
 */
export function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push({ dir, phase });
  return dir;
}

// Registered at import time (imports run during collection, before any
// hook defined in the test file itself).
beforeEach(() => {
  phase = "test";
});

afterEach(() => {
  drain("test");
});

afterAll(() => {
  drain("test");
  drain("collection");
});

/** Remove every tracked dir created in the given phase; never throws. */
function drain(when: Phase): void {
  for (let i = created.length - 1; i >= 0; i--) {
    if (created[i].phase !== when) continue;
    try {
      rmSync(created[i].dir, { recursive: true, force: true });
    } catch {
      // A leftover must not mask a real test failure — the global teardown
      // assertion (global-setup.ts) reports any dir that survives.
    }
    created.splice(i, 1);
  }
}
