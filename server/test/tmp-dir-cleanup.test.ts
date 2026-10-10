/**
 * ISSUE-50 AC3 — "a test that throws still cleans up its temp dir."
 *
 * `it.fails` records a deliberate failure: vitest still runs the suite's
 * afterEach hooks for it (that is the behavior under test), so the temp dir
 * created inside the throwing test must be gone by the time the next test
 * asserts on it. If someone later moves cleanup to a path that skips failed
 * tests, the second test fails and the leak guard (global-setup.ts) fails
 * the run with the surviving directory's name.
 */
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { testTmpDir } from "./helpers/tmp-dirs.js";

let dirFromThrowingTest = "";

it.fails("simulated failure after creating its temp dir", () => {
  dirFromThrowingTest = testTmpDir("dprelay-cleanup-guard-");
  throw new Error("deliberate failure — ISSUE-50 AC3 probe");
});

it("removed the throwing test's temp dir", () => {
  expect(dirFromThrowingTest).not.toBe("");
  expect(existsSync(dirFromThrowingTest)).toBe(false);
});
