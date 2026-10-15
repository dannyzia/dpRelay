/**
 * Pins the `core.hooksPath` reporting in `scripts/run-all-checks.sh`.
 *
 * The hazard this exists for: `core.hooksPath` is repo-LOCAL config and cannot
 * be committed, so a fresh clone runs no pre-commit hook at all until somebody
 * remembers the one-liner. `.githooks/pre-commit` is this repo's secret gate —
 * the thing that catches a credential before it reaches the index rather than
 * after it is pushed. A clone where it is silently inactive is exactly the
 * failure this must not hide.
 *
 * Two properties are pinned, both of which the original script got wrong:
 *
 *   - It reported the unset condition only AFTER fixing it, so the warning was
 *     unreachable and the gap stayed invisible.
 *   - It printed PASS without reading the config back, so a refused write still
 *     produced a green line about the secret gate being active.
 *
 * The block under test is extracted from the shipped script at runtime rather
 * than copied, so a refactor that moves it is caught instead of silently
 * leaving this test exercising stale code. Every scenario runs in a scratch
 * repository: nothing here can touch this repo's own git config — but that
 * holds only because the GIT_* overrides are scrubbed below; see the note
 * there for what this suite does without them.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DANGEROUS_GIT_VARS, scrubGitEnv } from "./helpers/git-test-env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every git override git exports into a hook environment, removed before this
 * suite spawns anything.
 *
 * The pre-push hook runs this suite via scripts/run-all-checks.sh, so GIT_DIR
 * already points at the LIVE worktree gitdir when these tests start. An
 * inherited override defeats `git init` in the scratch directory, so the
 * extracted block's `git rev-parse`/`git config` read the REAL repo's config
 * instead — which reports `core.hooksPath` already set and turns the very
 * warning this file exists to pin into an unreachable assertion (and
 * `chmod …/.git` then fails on a directory that was never created).
 *
 * Deleted from process.env at module scope rather than passed per call site:
 * the block under test is itself a shell fragment that forks its own `git`
 * children, so an `env:` on the outer call alone cannot cover them.
 * The six names themselves live in `helpers/git-test-env.ts`, shared with the
 * three suites that scrub them too. `server/test/secret-scan.test.ts` documents
 * the same hazard.
 */
for (const key of DANGEROUS_GIT_VARS) delete process.env[key];
const SCRIPT = join(repoRoot, "scripts", "run-all-checks.sh");

const WARNING = "core.hooksPath is unset while .githooks/pre-commit is tracked";

/** Preceded by exactly this comment, and ended by the next section's comment. */
const START_MARKER = "# Install the tracked pre-commit hook";
const END_MARKER = "# Resolve a JDK";

/**
 * The `pass`/`fail` helpers the block calls inside the real script.
 * `set -u` matches the script's own option.
 */
const PREAMBLE = `set -u
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; }
`;

/**
 * Lifts the hook block out of the shipped script.
 *
 * @returns the block, ready to hand to `bash -c`
 * @throws {Error} when the markers moved, so a silent no-op extraction cannot
 *   turn every assertion below into a vacuous pass
 */
function hookBlock(): string {
  const source = readFileSync(SCRIPT, "utf8");
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `could not locate the hook block in scripts/run-all-checks.sh (start=${start}, end=${end}) — the markers moved, so this test has nothing to assert on`,
    );
  }
  return source.slice(start, end);
}

/** One scenario, run against a throwaway git repository. */
interface Outcome {
  output: string;
  /** core.hooksPath after the block ran, or `UNSET`. */
  finalHooksPath: string;
  reportedPass: boolean;
  reportedFail: boolean;
}

/**
 * Builds a scratch repo in the requested state and runs the extracted block.
 *
 * @param opts.hooksPath the value to pre-set, or "UNSET"
 * @param opts.tracked whether `.githooks/pre-commit` is added to the index
 * @param opts.readOnlyGit make `.git` unwritable so the config write cannot land
 * @returns what the block printed and the resulting git state
 */
function runBlock(opts: { hooksPath: string; tracked: boolean; readOnlyGit?: boolean }): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "run-all-checks-hook-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(dir, ".githooks", "pre-commit"), 0o755);

    if (opts.tracked) execFileSync("git", ["add", ".githooks/pre-commit"], { cwd: dir });
    if (opts.hooksPath !== "UNSET") execFileSync("git", ["config", "core.hooksPath", opts.hooksPath], { cwd: dir });

    if (opts.readOnlyGit) chmodSync(join(dir, ".git"), 0o555);

    // Freshly scrubbed env as well as the module-scope loop: the block forks
    // its own git children, and this outer call is the last place a copy of
    // the inherited overrides could still be introduced (ISSUE-107 T3).
    const output = execFileSync("bash", ["-c", `${PREAMBLE}\n${hookBlock()}`], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubGitEnv(process.env),
    });

    if (opts.readOnlyGit) chmodSync(join(dir, ".git"), 0o755);

    const probe = (() => {
      try {
        return execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: dir, encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();

    return {
      output,
      finalHooksPath: probe === "" ? "UNSET" : probe,
      reportedPass: output.includes("PASS: git hooksPath"),
      reportedFail: output.includes("FAIL: git hooksPath"),
    };
  } finally {
    try {
      chmodSync(join(dir, ".git"), 0o755);
    } catch {
      // Already writable, or never created; nothing to restore.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("run-all-checks.sh core.hooksPath reporting", () => {
  it("has a locatable hook block, so the assertions below are not vacuous", () => {
    // Guards the extraction itself. Without this, markers moving would make
    // every other test throw rather than pass — which is what we want — but
    // failing here names the reason first.
    expect(hookBlock().length).toBeGreaterThan(200);
  });

  it("warns when core.hooksPath is unset and the hook is tracked", () => {
    // The requested behaviour: this is the state a fresh clone is in when the
    // tracked secret gate exists but nobody has wired it up.
    const run = runBlock({ hooksPath: "UNSET", tracked: true });

    expect(run.output).toContain(WARNING);
    expect(run.finalHooksPath).toBe(".githooks");
    expect(run.reportedPass).toBe(true);
    expect(run.reportedFail).toBe(false);
  });

  it("does not warn when the hook is untracked", () => {
    // An untracked .githooks/pre-commit is a local file no clone will ever
    // receive, so there is no gate to lose by leaving core.hooksPath alone —
    // the hook would not exist elsewhere to run.
    const run = runBlock({ hooksPath: "UNSET", tracked: false });

    expect(run.output).not.toContain(WARNING);
    expect(run.finalHooksPath).toBe(".githooks");
    expect(run.reportedPass).toBe(true);
  });

  it("does not warn when core.hooksPath is already configured", () => {
    const run = runBlock({ hooksPath: ".githooks", tracked: true });

    expect(run.output).not.toContain(WARNING);
    expect(run.finalHooksPath).toBe(".githooks");
    expect(run.reportedPass).toBe(true);
  });

  it("still redirects a hook path pointing elsewhere, without warning", () => {
    // Pre-existing behaviour that must not regress: any value other than
    // .githooks gets corrected. The warning is about an *unset* value only, so
    // this case stays quiet while the correction still happens.
    const run = runBlock({ hooksPath: "/somewhere/else", tracked: true });

    expect(run.output).not.toContain(WARNING);
    expect(run.finalHooksPath).toBe(".githooks");
    expect(run.reportedPass).toBe(true);
  });

  it("warns and reports FAIL when the write is refused, never a false green", () => {
    // The read-back. Printing PASS without checking would claim the secret gate
    // is active on a clone where nothing was configured.
    const run = runBlock({ hooksPath: "UNSET", tracked: true, readOnlyGit: true });

    expect(run.output).toContain(WARNING);
    expect(run.finalHooksPath).toBe("UNSET");
    expect(run.reportedFail).toBe(true);
    expect(run.reportedPass).toBe(false);
  });

  it("keeps the warning non-fatal so a warning alone cannot turn the suite red", () => {
    // A warning must be observability, not a failure: the script still fixes
    // the condition and reports PASS, so the gate stays green on a clone it
    // successfully repaired.
    const run = runBlock({ hooksPath: "UNSET", tracked: true });

    expect(run.output).toContain(WARNING);
    expect(run.reportedPass).toBe(true);
    expect(run.reportedFail).toBe(false);
    expect(run.output.match(/FAIL:/g) ?? []).toHaveLength(0);
  });

  it("skips cleanly when git is unavailable rather than failing the run", () => {
    // The block is guarded by `git rev-parse --git-dir`; if git were missing the
    // script would not enter it at all. Asserting the guard is present keeps a
    // future refactor from calling git unguarded.
    const block = hookBlock();
    expect(block).toContain("git rev-parse --git-dir >/dev/null 2>&1");
    expect(block).toContain("[ -f .githooks/pre-commit ]");
  });
});
