/**
 * Pins `.githooks/pre-commit`, the gate that sits between a working tree and
 * the index.
 *
 * Every scenario drives a REAL `git commit` in a scratch repository rather than
 * calling the hook directly, because that is the only way to prove the plumbing
 * git actually uses: which exit code reaches `git`, whether stdout/stderr is
 * visible to the person committing, and whether a gate that never runs still
 * lets the commit through.
 *
 * The properties worth pinning, in order of blast radius:
 *
 *   - The secret gate keeps its three-valued exit semantics. 1 means "found
 *     something", 2 means "the scan errored" — treating either as a pass is how
 *     a gate turns itself off without anyone noticing.
 *   - The HOOK and the LIVE GATE are proven together, end to end: every other
 *     scenario drives a stub gate whose exit code is chosen by the test, which
 *     proves the hook respects a verdict but never that a real staged secret
 *     produces one. One test copies the real scripts/secret-scan.sh into the
 *     scratch repo, plants credential-shaped content, and requires a real
 *     `git commit` to fail — so the hook cannot quietly stop invoking the
 *     scanner while every stub-based assertion stays green.
 *   - A missing gate script is a failure, never a pass. A path that quietly
 *     disappears reads as "nothing found" to any caller that treats absence as
 *     optional.
 *   - The test suite is never invoked. It is the slow part by an order of
 *     magnitude, and a hook slow enough to annoy gets bypassed with
 *     --no-verify — which silences the secret gate with it. Canary shims named
 *     `vitest`/`playwright`/`npx` are put first on PATH so this is observed,
 *     not inferred from reading the source.
 *   - ktlint only runs when `authenticator-app/` is staged. Measured on this
 *     machine: 51s cold daemon, 25s forced re-run, 2.7s warm. And when it does
 *     not run, the output must SAY it did not run rather than imply a clean
 *     lint — a skip that reads as a pass is the same lie as a missing gate.
 *
 * Nothing here touches this repository's own index or hooks — but that holds
 * only because the GIT_* overrides are scrubbed below; see the note there for
 * what this suite does without them.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DANGEROUS_GIT_VARS, scrubGitEnv } from "./helpers/git-test-env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(repoRoot, ".githooks", "pre-commit");

/**
 * Every git override git exports into a hook environment, removed before this
 * suite spawns anything.
 *
 * The pre-commit hook runs this very suite via scripts/run-all-checks.sh, so
 * git has already exported GIT_DIR pointing at the LIVE worktree gitdir by the
 * time these tests start. An inherited override defeats `git init` — the
 * scratch rig is never created — and then `git add` + `git commit -m x` land on
 * the checked-out branch of the REAL repository, committing only the fixture
 * files and gutting the branch while every assertion still describes a
 * throwaway repo. That is not hypothetical here: it is what produced the stray
 * `x` commits and the missing files on this branch.
 *
 * Deleted from process.env at module scope rather than passed per call site:
 * this file spawns git a dozen times plus grandchildren forked by the gate
 * shell itself, and one missed `env:` reintroduces a destructive bug that only
 * shows up when the suite is run FROM a hook. The six names themselves live in
 * `helpers/git-test-env.ts`, shared with the three suites that scrub them too.
 * `server/test/secret-scan.test.ts` documents the same hazard and scopes its
 * own `rigEnv` per call.
 */
for (const key of DANGEROUS_GIT_VARS) delete process.env[key];

/**
 * Stub gate bodies. Each exits the way the real gate would.
 *
 * Named for the gate each one stubs (secret-scan, AGPL, gradle). The
 * secret-scan stub is deliberately NOT called `CLEAN_SECRET`: its body is a
 * shell script, not a credential, and `scripts/secret-scan.sh` flags any
 * `*_SECRET = "..."` constant long enough to hold one. Renaming keeps the
 * whole file inside the secret gate's coverage instead of buying an
 * allowlist entry for it.
 */
const CLEAN_GATE = "#!/bin/bash\nexit 0\n";
const CLEAN_AGPL = "#!/bin/bash\necho 'AGPL identifier gate: clean'\nexit 0\n";
// Records its own argv so "gradlew was never asked to run tests" is asserted on
// the call itself, not only on hook source text.
const CLEAN_GRADLE = '#!/bin/bash\necho "$@" >> ../gradlew-args.log\necho "BUILD SUCCESSFUL"\nexit 0\n';

/** Shims placed first on PATH; touching this file means a test runner ran. */
const CANARY = "canary-ran";

interface Opts {
  secretExit?: number;
  agpl?: string;
  gradle?: string;
  missingSecret?: boolean;
  missingAgpl?: boolean;
  missingGradlew?: boolean;
  /** Copy the real secret-scan.sh (plus its allowlist filter) instead of a stub. */
  realSecretGate?: boolean;
}

/** Every scratch repo created, so the suite does not litter the temp dir. */
const scratchRepos: string[] = [];

afterAll(() => {
  for (const repo of scratchRepos) rmSync(repo, { recursive: true, force: true });
});

/** Builds a scratch repo wired to run the real hook. */
function makeRepo(opts: Opts = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "precommit-"));
  scratchRepos.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  git("init", "-q", ".");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.hooksPath", ".githooks");

  mkdirSync(join(repo, ".githooks"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "authenticator-app"));
  mkdirSync(join(repo, "bin"));
  copyFileSync(HOOK, join(repo, ".githooks", "pre-commit"));

  const put = (rel: string, body: string) => {
    writeFileSync(join(repo, rel), body);
    chmodSync(join(repo, rel), 0o755);
  };

  if (opts.realSecretGate) {
    // The live gate, copied so this scenario exercises the real scripts rather
    // than a copy that can drift from them. All three files are needed: the
    // gate pipes `git ls-files` through filter-allowlist.cjs, which reads the
    // allowlist file — and a missing allowlist would make the gate report
    // "nothing to scan" rather than fail.
    for (const gateFile of ["secret-scan.sh", "filter-allowlist.cjs", "secret-scan-allowlist.txt"]) {
      copyFileSync(join(repoRoot, "scripts", gateFile), join(repo, "scripts", gateFile));
    }
  } else {
    put("scripts/secret-scan.sh", opts.secretExit !== undefined ? `#!/bin/bash\necho 'secret gate tripped'\nexit ${opts.secretExit}\n` : CLEAN_GATE);
  }
  if (opts.missingSecret) rmSync(join(repo, "scripts", "secret-scan.sh"));
  if (!opts.missingAgpl) put("scripts/agpl-grep.sh", opts.agpl ?? CLEAN_AGPL);
  if (!opts.missingGradlew) put("authenticator-app/gradlew", opts.gradle ?? CLEAN_GRADLE);

  for (const runner of ["vitest", "playwright", "npx"]) {
    put(
      `bin/${runner}`,
      `#!/bin/bash\ntouch '${join(repo, CANARY)}'\necho '${runner} invoked by hook' >&2\nexit 99\n`,
    );
  }
  return repo;
}

interface Result {
  code: number;
  out: string;
  repo: string;
}

/** Stages `f.txt` (and optionally a Kotlin file) and commits for real. */
function commit(repo: string, opts: { kotlin?: boolean } = {}): Result {
  writeFileSync(join(repo, "f.txt"), "change\n");
  execFileSync("git", ["add", "f.txt"], { cwd: repo, stdio: "ignore" });

  if (opts.kotlin) {
    writeFileSync(join(repo, "authenticator-app", "Main.kt"), "fun main() {}\n");
    execFileSync("git", ["add", "authenticator-app/Main.kt"], { cwd: repo, stdio: "ignore" });
  }

  // Scrubbed explicitly too, not only by the module-scope loop above: this is
  // the one place that builds a child env from scratch, so it must not be able
  // to reintroduce an override by copying one in (ISSUE-107 T3).
  const env = {
    ...scrubGitEnv(process.env),
    PATH: `${join(repo, "bin")}${":"}${process.env.PATH ?? ""}`,
  };
  const p = spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: repo, encoding: "utf8", env });
  return { code: p.status ?? -1, out: `${p.stdout ?? ""}${p.stderr ?? ""}`, repo };
}

const gradlewArgs = (repo: string): string => {
  const file = join(repo, "gradlew-args.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

describe(".githooks/pre-commit", () => {
  it("runs the hook file: it exists, is executable, and is syntactically valid", () => {
    expect(existsSync(HOOK)).toBe(true);
    const syntax = spawnSync("bash", ["-n", HOOK], { encoding: "utf8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);
  });

  it("lets a clean commit through and reports all three gates", () => {
    const r = commit(makeRepo(), { kotlin: true });

    expect(r.code).toBe(0);
    expect(r.out).toContain("secret gate clean");
    expect(r.out).toContain("AGPL identifier gate clean");
    expect(r.out).toContain("ktlint clean");
    expect(r.out).not.toContain("SKIP ktlint");
    expect(r.out).toContain("Test suite runs in CI");
  });

  it("blocks on the secret gate and never reaches the later gates", () => {
    const r = commit(makeRepo({ secretExit: 1 }));

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("secret gate found something");
    // Fail fast: a secret failure must not be buried under lint output.
    expect(r.out).not.toContain("AGPL identifier gate clean");
  });

  it("treats a secret gate that errored as a failure, not as a clean scan", () => {
    // exit 2 is the gate's own "I did not actually run" signal. Reading it as a
    // pass would let a broken scanner wave every commit through.
    const r = commit(makeRepo({ secretExit: 2 }));

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("failed to run (exit 2)");
    expect(r.out).toContain("NOT a pass");
  });

  it("blocks a REAL planted secret end to end — the hook cannot unhook itself from the live gate", () => {
    const repo = makeRepo({ realSecretGate: true });

    // Control: with the live gate in place an ordinary commit still passes.
    // Without this, "the commit was blocked" would also be satisfied by a gate
    // that rejects everything — which teaches --no-verify, silencing the
    // secret gate along with it.
    const clean = commit(repo);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("secret gate clean");

    // Plant: assembled from fragments, so this file itself never contains the
    // contiguous credential shape. server/test/pre-commit-hook.test.ts is not
    // in the secret-scan allowlist, and the allowlist's own comment names
    // concatenation as the mitigation for fixtures like this one. The header
    // halves are concatenated rather than "\n"-joined: the scanner's rule
    // matches the PEM header on a SINGLE line — a split header is inert in
    // both places, which is exactly what we want of this file's source.
    const header = "-----BEGIN" + " RSA PRIVATE KEY-----";
    const footer = "-----END" + " RSA PRIVATE KEY-----";
    const planted = `${header}\nMIIBfakeMaterialForTestOnlyThisIsNotACredentialAAAA\n${footer}`;
    writeFileSync(join(repo, "leak.txt"), `${planted}\n`);
    execFileSync("git", ["add", "leak.txt"], { cwd: repo, stdio: "ignore" });

    // Layer 1 — the live scanner really does see it. Asserted first so a
    // failure here is attributed to the scanner rather than to the hook.
    const gate = spawnSync("bash", ["scripts/secret-scan.sh"], { cwd: repo, encoding: "utf8" });
    const gateOut = `${gate.stdout ?? ""}${gate.stderr ?? ""}`;
    expect(gate.status).toBe(1);
    expect(gateOut).toContain("secret-shaped content in tracked files");

    // Layer 2 — the hook turns that finding into a blocked commit. Nothing in
    // this test stubs the gate, so a hook that stopped invoking it (or stopped
    // honouring its exit code) would let this commit through.
    const r = commit(repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("secret gate found something");
    // The live scanner's own verdict must be visible in the hook's output —
    // proof the real gate ran inside the hook, not a stand-in.
    expect(r.out).toContain("secret gate FAILED — secret-shaped content in tracked files");

    // Layer 3 — the secret never entered history: HEAD is still the control
    // commit, the planted file is still only staged, and it is not in the tree.
    const headSubject = execFileSync("git", ["log", "--format=%s", "-1"], { cwd: repo, encoding: "utf8" }).trim();
    expect(headSubject).toBe("x");
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" })).toContain("leak.txt");
    expect(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" })).not.toContain("leak.txt");
  });

  it("blocks when the secret gate script itself is missing", () => {
    // The original and most important fail-closed rule: a gate that has
    // disappeared must not read as "nothing found".
    const r = commit(makeRepo({ missingSecret: true }));

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("NOT a pass");
    expect(r.out).toContain("scripts/secret-scan.sh");
    expect(r.out).not.toContain("secret gate clean");
  });

  it("fails closed when the AGPL gate script is missing", () => {
    const r = commit(makeRepo({ missingAgpl: true }));

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("NOT a pass");
    expect(r.out).toContain("scripts/agpl-grep.sh");
  });

  it("blocks when the AGPL gate reports a violation", () => {
    const r = commit(makeRepo({ agpl: "#!/bin/bash\necho 'found a violation'\nexit 1\n" }));

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("AGPL identifier gate failed");
  });

  it("skips ktlint loudly when the toolchain is absent, keeping the secret gate active", () => {
    // Blocking a TypeScript-only commit on a missing JDK teaches --no-verify,
    // which silences the secret gate too. So it skips — but says so.
    const r = commit(makeRepo({ missingGradlew: true }), { kotlin: true });

    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIP ktlint");
    expect(r.out).toContain("this is not a pass");
    expect(r.out).toContain("secret gate clean");
  });

  it("blocks when ktlint fails on staged Kotlin", () => {
    const r = commit(makeRepo({ gradle: "#!/bin/bash\necho 'Lint error: Foo.kt:1'\nexit 1\n" }), { kotlin: true });

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ktlint failed");
    // The captured Gradle output must be surfaced, because the failing task is
    // the only clue to what went wrong.
    expect(r.out).toContain("Foo.kt");
  });

  it("never invokes the test suite", () => {
    const r = commit(makeRepo(), { kotlin: true });

    expect(r.code).toBe(0);
    expect(existsSync(join(r.repo, CANARY))).toBe(false);
    expect(gradlewArgs(r.repo)).toContain("ktlintCheck");
    expect(gradlewArgs(r.repo).replace(/ktlintCheck/g, "")).not.toContain("test");
  });

  it("does not run ktlint when no authenticator-app/ change is staged", () => {
    const r = commit(makeRepo());

    expect(r.code).toBe(0);
    expect(r.out).toContain("ktlint not run");
    // The distinction this whole scenario exists for: "not run" must never be
    // phrased as a clean lint.
    expect(r.out).not.toContain("ktlint clean");
    expect(gradlewArgs(r.repo)).toBe("");
    expect(r.out).toContain("secret gate clean");
  });

  it("contains no test-runner command in its code lines", () => {
    // The prose header deliberately discusses the test suite; only executable
    // lines are under test here.
    const code = readFileSync(HOOK, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");

    expect(code).not.toMatch(/vitest|playwright|gradlew test|npm (run )?test/);
    // And the hooks it does call are the ones this change is about.
    expect(code).toContain("scripts/secret-scan.sh");
    expect(code).toContain("scripts/agpl-grep.sh");
    expect(code).toContain("ktlintCheck");
  });
});
