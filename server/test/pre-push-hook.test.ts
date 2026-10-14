/**
 * Pins `.githooks/pre-push`, the gate between a local branch and the remote.
 *
 * Every scenario drives a REAL `git push` against a scratch bare remote rather
 * than calling the hook directly, because that is the only way to prove the
 * plumbing git actually uses: whether a non-zero hook exit really keeps the ref
 * off the remote, whether the pusher sees the failure text, and whether the
 * suite runs at all when the ref names on both sides look identical.
 *
 * The properties worth pinning, in order of blast radius:
 *
 *   - The suite runs whenever new objects travel. A first draft of this hook
 *     read the stdin fields in the wrong order (it assumed
 *     `<local-sha> <local-ref> <remote-sha> <remote-ref>`; githooks(5) says
 *     `<local ref> <local object name> <remote ref> <remote object name>`),
 *     which made a plain same-named push compare the two REF NAMES, find them
 *     equal, and declare "up to date" — pushing a brand-new branch with no
 *     suite at all. That is fail-open, so the regression is pinned twice: once
 *     through real pushes, once by feeding the hook the documented stdin
 *     format directly.
 *   - The suite is SKIPPED when nothing new reaches the remote (up-to-date
 *     refs, deletions, and git's own empty line list for an
 *     everything-up-to-date push). The owner's stated design; paying two
 *     minutes to re-confirm state the remote holds is how hooks get
 *     `--no-verify`'d out of existence.
 *   - A failing suite, and a suite script that is MISSING, both block the
 *     push. An absent path that reads as "nothing found" is how a gate turns
 *     itself off; a push is the worst place to discover it.
 *
 * Nothing here touches this repository's own index, remotes, or hooks.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(repoRoot, ".githooks", "pre-push");

interface Opts {
  suiteExit?: number;
  missingSuite?: boolean;
}

/** Every scratch repo created, so the suite does not litter the temp dir. */
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Repo {
  root: string;
  remote: string;
  work: string;
}

/** Builds a scratch work repo plus a stub bare remote wired to the real hook. */
function makeRepo(opts: Opts = {}): Repo {
  const root = mkdtempSync(join(tmpdir(), "prepush-"));
  scratch.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", work);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  git(work, "config", "core.hooksPath", ".githooks");

  mkdirSync(join(work, ".githooks"));
  mkdirSync(join(work, "scripts"));
  copyFileSync(HOOK, join(work, ".githooks", "pre-push"));
  chmodSync(join(work, ".githooks", "pre-push"), 0o755);

  if (!opts.missingSuite) {
    writeFileSync(
      join(work, "scripts", "run-all-checks.sh"),
      `#!/bin/bash\necho '  [stub suite ran]'\nexit ${opts.suiteExit ?? 0}\n`,
    );
    chmodSync(join(work, "scripts", "run-all-checks.sh"), 0o755);
  }
  return { root, remote, work };
}

/** Writes a tracked file and commits for real. */
function commit(repo: Repo, msg: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.work, stdio: "ignore" });
  writeFileSync(join(repo.work, `${msg}.txt`), `${msg}\n`);
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
}

interface PushResult {
  code: number;
  out: string;
  err: string;
}

/** Runs a real `git push`; never throws, so failures can be asserted on. */
function push(repo: Repo, ...args: string[]): PushResult {
  const p = spawnSync("git", ["push", ...args], { cwd: repo.work, encoding: "utf8" });
  return { code: p.status ?? -1, out: p.stdout ?? "", err: p.stderr ?? "" };
}

/** Heads the remote actually holds — the ground truth for "did it land?". */
function remoteHeads(repo: Repo): string {
  return execFileSync("git", ["ls-remote", "--heads", repo.remote], { cwd: repo.work, encoding: "utf8" });
}

describe(".githooks/pre-push", () => {
  it("exists, is executable, and is syntactically valid bash", () => {
    expect(existsSync(HOOK)).toBe(true);
    expect(readFileSync(HOOK, { encoding: "utf8" }).startsWith("#!/usr/bin/env bash")).toBe(true);
    const mode = execFileSync("stat", ["-c", "%a", HOOK], { encoding: "utf8" }).trim();
    expect(mode).toBe("755");
    const syn = spawnSync("bash", ["-n", HOOK], { encoding: "utf8" });
    expect(syn.status).toBe(0);
  });

  it("runs the suite for a plain same-named push carrying a new commit", () => {
    const repo = makeRepo();
    commit(repo, "c1");
    const r = push(repo, repo.remote, "HEAD:refs/heads/master");
    expect(r.code).toBe(0);
    expect(r.out).toContain("carries new object(s)");
    expect(r.out).toContain("[stub suite ran]");
    expect(r.out).toContain("full check suite passed");
    expect(remoteHeads(repo)).toContain("refs/heads/master");
  });

  it("skips the suite when the remote already holds that exact object", () => {
    const repo = makeRepo();
    commit(repo, "c1");
    expect(push(repo, repo.remote, "HEAD:refs/heads/master").code).toBe(0);

    const second = push(repo, repo.remote, "HEAD:refs/heads/master");
    expect(second.code).toBe(0);
    expect(second.out).toContain("suite not run");
    expect(second.out).not.toContain("[stub suite ran]");
  });

  it("runs the suite for a brand-new branch", () => {
    const repo = makeRepo();
    commit(repo, "c1");
    expect(push(repo, repo.remote, "HEAD:refs/heads/master").code).toBe(0);

    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo.work });
    commit(repo, "c2");
    const r = push(repo, repo.remote, "feature");
    expect(r.code).toBe(0);
    expect(r.out).toContain("[stub suite ran]");
    expect(remoteHeads(repo)).toContain("refs/heads/feature");
  });

  it("runs the suite when one ref in the push is new and another is up to date", () => {
    const repo = makeRepo();
    commit(repo, "c1");
    expect(push(repo, repo.remote, "HEAD:refs/heads/master").code).toBe(0);

    execFileSync("git", ["checkout", "-q", "-b", "mixed"], { cwd: repo.work });
    commit(repo, "c2");
    const r = push(repo, repo.remote, "mixed", "master");
    expect(r.code).toBe(0);
    expect(r.out).toContain("pre-push: refs/heads/mixed carries new object(s)");
    expect(r.out).toContain("[stub suite ran]");
  });

  it("blocks a push when the suite fails, leaving the ref off the remote", () => {
    const repo = makeRepo({ suiteExit: 1 });
    commit(repo, "c1");
    const r = push(repo, repo.remote, "HEAD:refs/heads/master");

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("BLOCKED — the full check suite failed (exit 1)");
    expect(r.err).toContain("git push --no-verify");
    // The decision text belongs on stderr: stdout is where the suite streams.
    expect(r.out).not.toContain("BLOCKED");
    expect(remoteHeads(repo)).not.toContain("refs/heads/master");
  });

  it("fails closed when the suite script is missing — a missing gate is not a pass", () => {
    const repo = makeRepo({ missingSuite: true });
    commit(repo, "c1");
    const r = push(repo, repo.remote, "HEAD:refs/heads/master");

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("missing");
    expect(r.err).toContain("NOT a pass");
    expect(remoteHeads(repo)).not.toContain("refs/heads/master");
  });

  it("does not run the suite when a ref is deleted, and the delete succeeds", () => {
    const repo = makeRepo();
    commit(repo, "c1");
    expect(push(repo, repo.remote, "HEAD:refs/heads/master").code).toBe(0);
    execFileSync("git", ["branch", "-q", "other"], { cwd: repo.work });
    expect(push(repo, repo.remote, "other:refs/heads/other").code).toBe(0);

    const r = push(repo, repo.remote, "--delete", "refs/heads/other");
    expect(r.code).toBe(0);
    expect(r.out).toContain("suite not run");
    expect(r.out).not.toContain("[stub suite ran]");
    expect(remoteHeads(repo)).not.toContain("refs/heads/other");
  });

  it("streams the suite's own output to the person pushing", () => {
    const repo = makeRepo();
    commit(repo, "c1");
    const r = push(repo, repo.remote, "HEAD:refs/heads/master");
    // A hook silent for two minutes reads as a hung terminal, and a hung
    // terminal is what people Ctrl-C on the way to --no-verify.
    expect(r.out).toContain("[stub suite ran]");
  });

  it("leaves `git push --no-verify` working — CI re-runs every gate regardless", () => {
    const repo = makeRepo({ missingSuite: true });
    commit(repo, "c1");
    const r = push(repo, repo.remote, "--no-verify", "HEAD:refs/heads/master");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("pre-push:");
  });

  // --- the field-order regression, fed directly in githooks(5) format ------
  // Real pushes cover this too, but only for refs git happens to offer. This
  // pins the parser against the documented line format verbatim, so a future
  // "cleanup" of the read loop cannot silently reopen the fail-open hole.
  describe("stdin parsing (githooks(5): <local ref> SP <local object> SP <remote ref> SP <remote object>)", () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const zero = "0".repeat(40);

    /** Invokes the hook outside `git push` with one synthetic ref line. */
    function hookStdin(repo: Repo, line: string): PushResult {
      const p = spawnSync("bash", [HOOK, "origin", "/tmp/stub-remote.git"], {
        cwd: repo.work,
        encoding: "utf8",
        input: `${line}\n`,
      });
      return { code: p.status ?? -1, out: p.stdout ?? "", err: p.stderr ?? "" };
    }

    it("runs the suite when identical ref names carry different objects", () => {
      const repo = makeRepo();
      // Exactly what broke the first draft: both sides are refs/heads/master,
      // so any comparison of the REF NAMES declares "up to date".
      const r = hookStdin(repo, `refs/heads/master ${shaA} refs/heads/master ${shaB}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("[stub suite ran]");
    });

    it("skips when both object names match", () => {
      const repo = makeRepo();
      const r = hookStdin(repo, `refs/heads/master ${shaA} refs/heads/master ${shaA}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("suite not run");
      expect(r.out).not.toContain("[stub suite ran]");
    });

    it("treats an all-zeroes local object name as a deletion and skips", () => {
      const repo = makeRepo();
      // githooks(5): on delete the local ref reads "(delete)" and the local
      // object name is all zeroes — no object travels, nothing to check.
      const r = hookStdin(repo, `(delete) ${zero} refs/heads/master ${shaA}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("suite not run");
      expect(r.out).not.toContain("[stub suite ran]");
    });

    it("runs the suite for a new remote ref (all-zeroes on the remote side)", () => {
      const repo = makeRepo();
      const r = hookStdin(repo, `refs/heads/master ${shaA} refs/heads/master ${zero}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("[stub suite ran]");
    });

    it("skips when git offers no ref lines — that is the everything-up-to-date push", () => {
      const repo = makeRepo();
      const r = hookStdin(repo, "");
      expect(r.code).toBe(0);
      expect(r.out).toContain("suite not run");
      expect(r.out).not.toContain("[stub suite ran]");
    });

    it("blocks without a remote when run outside a git repository", () => {
      const outside = mkdtempSync(join(tmpdir(), "prepush-nogit-"));
      scratch.push(outside);
      const p = spawnSync("bash", [HOOK, "origin", "/tmp/stub-remote.git"], {
        cwd: outside,
        encoding: "utf8",
        input: "",
      });
      expect(p.status).not.toBe(0);
      expect(p.stderr).toContain("not inside a git repository");
    });
  });
});
