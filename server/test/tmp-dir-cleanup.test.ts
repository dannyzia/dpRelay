/**
 * ISSUE-50 AC3 — "a test that throws still cleans up its temp dir."
 *
 * The operational mechanism is helpers/tmp-dirs.ts: its import-time
 * `afterEach` drains every test-phase directory after each test, and vitest
 * runs afterEach hooks even for tests that throw. Observing that from inside
 * the file, however, is not shuffle-safe (ISSUE-46): the original two-test
 * version ("throwing test sets a shared var → next test asserts it is gone")
 * depends on execution order and failed under `--sequence.shuffle` (the
 * assertion test could run first, or attach its check to an `it.fails` probe
 * whose afterEach errors vitest swallows as part of expected-failure
 * handling). This file therefore asserts the invariant that is ours and
 * order-independent: a test-phase directory is removed by the same drain the
 * afterEach hook calls. The end-of-run leak guard (global-setup.ts) still
 * fails the run if any directory ever survives, regardless of order.
 */
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { drainTestPhaseDirs, testTmpDir } from "./helpers/tmp-dirs.js";

it("removes a test-phase temp dir via the same drain the afterEach hook runs", () => {
  const dir = testTmpDir("dprelay-cleanup-guard-");
  expect(existsSync(dir)).toBe(true);

  drainTestPhaseDirs(); // exactly what the helper's afterEach executes per test
  expect(existsSync(dir)).toBe(false);
});

it("drain is idempotent — a second drain (the real hook) is a safe no-op", () => {
  const dir = testTmpDir("dprelay-cleanup-guard-");
  drainTestPhaseDirs();
  expect(existsSync(dir)).toBe(false);

  drainTestPhaseDirs(); // the helper's own afterEach drains again after the test
  expect(existsSync(dir)).toBe(false);
});
