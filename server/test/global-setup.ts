/**
 * ISSUE-50 AC1/AC2 — assert (never delete) that a full run leaks nothing.
 *
 * Snapshots every test scratch directory in `os.tmpdir()` when the run
 * starts; after the last test, any matching directory that appeared during
 * the run is a leak and fails the whole suite with its name. This is the
 * "asserted rather than eyeballed" half of the fix: the per-test cleanup
 * lives in helpers/tmp-dirs.ts (root cause), and this guard proves it — a
 * cron-style sweep was explicitly rejected in ISSUE-50 because it would hide
 * the bug while the disk still fills mid-session.
 *
 * Matching covers every prefix the suite creates, including the three that
 * do not start with `dprelay-`.
 */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

/** Every scratch-dir prefix the server suite creates (see mkdtemp call sites). */
const TEST_DIR = /^(dprelay-|secret-store-test-|render-key-test-|f8-reader-)/;

let baseline = new Set<string>();

/** Record the pre-existing scratch dirs so oldabandoned ones don't fail this run. */
export function setup(): void {
  baseline = new Set(listScratchDirs());
}

/** Fail the run if any test scratch dir created during the run survives. */
export function teardown(): void {
  const leaked = listScratchDirs().filter((name) => !baseline.has(name));
  if (leaked.length > 0) {
    const shown = leaked.slice(0, 10).join(", ");
    throw new Error(
      `ISSUE-50: ${leaked.length} test temp dir(s) leaked into ${tmpdir()}: ` +
        `${shown}${leaked.length > 10 ? ", …" : ""}`,
    );
  }
}

/** Names of the test scratch directories currently in os.tmpdir(). */
function listScratchDirs(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TEST_DIR.test(entry.name))
    .map((entry) => entry.name);
}
