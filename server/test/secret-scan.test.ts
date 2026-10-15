/**
 * Secret-scan gate regression tests.
 *
 * A gate that only ever reports "clean" is worthless, and this one already had
 * the failure mode that makes it worthless: `git grep -E "$SECRET_RE"` treated
 * a pattern beginning with "-----BEGIN" as a command-line OPTION, and the
 * surrounding `|| true` swallowed the resulting usage error. The gate printed
 * "secret gate: clean" while matching nothing at all.
 *
 * Two lessons are pinned here:
 *   1. every secret shape must actually trip the gate;
 *   2. ordinary code, docs prose and allowlisted paths must NOT trip it, so the
 *      gate cannot be "fixed" by disabling it.
 *   3. the rig must be hermetic: its marker commits belong in its own temp
 *      repository and NEVER on a live branch — see rigEnv below for how an
 *      inherited GIT_DIR (git exports it into hook environments) silently
 *      defeats `git init` and what that cost once already.
 *   4. a scan that could not run is an ERROR, never a pass: a filter that
 *      throws — or a node that never starts — must leave exit 2, not an empty
 *      list the gate reads as "nothing to scan" (ISSUE-107 C1).
 *
 * A mangled pattern can still compile (an unclosed "[" swallows the rest of the
 * alternation into a literal bracket expression), so the only real defence
 * against that is this test — not the shell.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubGitEnv } from "./helpers/git-test-env.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

// fileURLToPath, not `.pathname`: the repo path contains a space, so the raw
// pathname arrives percent-encoded and every fs call misses.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GATE_FILES = ["secret-scan.sh", "filter-allowlist.cjs", "secret-scan-allowlist.txt"];

let rig: string;

/**
 * Environment for every git and gate invocation the rig makes.
 *
 * git EXPORTS GIT_DIR into hook environments: the pre-push hook runs this
 * very suite via scripts/run-all-checks.sh, so GIT_DIR points at the LIVE
 * worktree gitdir by the time these tests start. An inherited GIT_DIR defeats
 * `git init` outright — the fresh temp repo is never created, `git add -A`
 * treats the rig directory as the work tree, and `git commit` commits to the
 * checked-out branch of the REAL repository. That is not hypothetical: every
 * pre-push run left a chain of "rig state" commits on fold-5160/stage-e-m4p3
 * whose trees contained only the fixture files, gutting the branch and
 * invalidating PR heads. Scrub every git override so the rig is its own
 * repository wherever the suite is launched from, and assert it in beforeAll.
 */
// The list of overrides itself lives in helpers/git-test-env.ts so this suite
// and the three hook suites scrub an identical set — a suite that forgets an
// entry is how this hazard came back once already (ISSUE-107 T3).
const rigEnv: NodeJS.ProcessEnv = scrubGitEnv(process.env);

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: rig, encoding: "utf8", env: rigEnv });

/** Commit whatever is in the rig, then run the gate against that committed state. */
function scan(): { code: number; out: string } {
  git(["add", "-A"]);
  // --allow-empty: several tests re-scan an unchanged tree, and a bare commit
  // with nothing staged exits 1, which would fail the test for the wrong reason.
  git(["commit", "-q", "--allow-empty", "-m", "rig state"]);
  const res = spawnSync("bash", ["scripts/secret-scan.sh"], { cwd: rig, encoding: "utf8", env: rigEnv });
  return { code: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

beforeAll(() => {
  rig = testTmpDir("dprelay-secret-scan-");
  mkdirSync(join(rig, "scripts"), { recursive: true });
  // Copy the live gate so these tests exercise the real scripts, not a copy
  // that can drift from them.
  for (const f of GATE_FILES) {
    cpSync(join(REPO_ROOT, "scripts", f), join(rig, "scripts", f));
  }
  git(["init", "-q", "."]);
  // Fail closed on broken isolation: rigEnv is the defence, this is the proof
  // it held. If git ever resolves anywhere but the rig's own .git, every later
  // commit in this file would land on a live branch — exactly the incident this pins.
  const actualGitDir = realpathSync(
    execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: rig, encoding: "utf8", env: rigEnv }).trim(),
  );
  const expectedGitDir = realpathSync(join(rig, ".git"));
  if (actualGitDir !== expectedGitDir) {
    throw new Error(`rig isolation broken: git-dir ${actualGitDir} !== ${expectedGitDir}`);
  }
  git(["config", "user.email", "rig@example.com"]);
  git(["config", "user.name", "rig"]);
  writeFileSync(join(rig, "README.md"), "# rig\n");
  writeFileSync(join(rig, "app.ts"), 'export const port = 8080;\n');
});

afterAll(() => {
  rmSync(rig, { recursive: true, force: true });
});

describe("secret gate: clean repositories pass", () => {
  it("passes on ordinary source and docs", () => {
    writeFileSync(join(rig, "NOTES.md"), "Configure RENDER_API_KEY and GOOGLE_APPLICATION_CREDENTIALS.\n");
    writeFileSync(join(rig, "server.env.example"), "JWT_SECRET=\nOPERATOR_SECRET=\n");
    const { code, out } = scan();
    expect(out).toContain("secret gate: clean");
    expect(code).toBe(0);
  });

  it("does not flag .env.example, which is documentation", () => {
    expect(scan().code).toBe(0);
  });

  it("does not flag placeholder, port-only or email-only URLs", () => {
    // AC3 (ISSUE-102): the userinfo rule must not catch the shapes docs use
    // every day — no password means no colon before the @, and a port number
    // is not userinfo. One file so the first FP would fail the whole test.
    writeFileSync(
      join(rig, "urls.env.example"),
      [
        "# Example: https://dprelay-dashboard.pages.dev,http://localhost:5173",
        "R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com",
        "AUTHOR=https://github.com/dannyzia",
        "HEALTH=http://127.0.0.1:8123/health",
        "SUPPORT=mailto:ops@example.com",
      ].join("\n") + "\n",
    );
    const { code, out } = scan();
    rmSync(join(rig, "urls.env.example"));
    expect(out).toContain("secret gate: clean");
    expect(code).toBe(0);
  });

  it("does not flag fixture-shaped credential constants", () => {
    // AC3 companion for rule 2c (ISSUE-102): the fixture idioms this repo
    // uses by convention must not trip the plaintext-constant rule — a gate
    // red on day one gets disabled by week two. Each line here mirrors a
    // class of lines that exists on master right now.
    writeFileSync(
      join(rig, "fixtures.ts"),
      [
        'const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";',
        'const SMTP_PASSWORD = "super-secret-smtp-password";',
        'const APP_SECRET_KEY = "webv5.appSecret";',
        'const VALID_CHALLENGE_TOKEN = "aBC123...";',
        'const SECRET = "dev-enroll-value";',
        "const TEST_PASSWORD = 'E2ePassw0rd!';",
      ].join("\n") + "\n",
    );
    const { code, out } = scan();
    rmSync(join(rig, "fixtures.ts"));
    expect(out).toContain("secret gate: clean");
    expect(code).toBe(0);
  });
});

describe("secret gate: credential content is caught", () => {
  const SHAPES: { name: string; file: string; body: string }[] = [
    {
      name: "a GCP service-account private_key",
      file: "leak-sa.json",
      body: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\\n"}\n',
    },
    {
      name: "a bare PEM private key",
      file: "leaked.pem",
      body: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n",
    },
    { name: "a Render API key", file: "render.cfg", body: "K=rnd_AbCdEf0123456789XyZa\n" },
    { name: "a Google API key", file: "webkey.txt", body: "K=AIzaSyD-1234567890abcdefghijklmnopqrstu\n" },
    { name: "a GitHub token", file: "tok.txt", body: "T=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n" },
    { name: "a GitHub PAT", file: "pat.txt", body: "T=github_pat_11ABCDEFG0abcdefghijklmnop\n" },
    { name: "a Slack token", file: "slack.txt", body: "T=xoxb-123456789012-abcdefghij\n" },
    { name: "an AWS access key id", file: "aws.txt", body: "A=AKIAIOSFODNN7EXAMPLE\n" },
    { name: "a Stripe live key", file: "stripe.txt", body: "L=sk_live_0123456789abcdefgh\n" },
    { name: "a long base64 blob that could be a stripped PEM", file: "blob.txt", body: `${"A".repeat(600)}\n` },
    {
      // ISSUE-102: credentials hiding in URL userinfo have no key-format
      // prefix, so the SECRET_RE shapes above can never see them. The colon is
      // what makes it a credential rather than a bare username.
      name: "credentials embedded in a URL userinfo",
      file: "callback.txt",
      body: "LOGIN=https://admin:Sup3rS3cret!@dashboard.example.com/login\n",
    },
    {
      // ISSUE-102 AC2: the credential mod4 actually carried — a plaintext
      // constant, not a URL. Invisible to every key-format rule above; the
      // NAME is the only signal, which is exactly what rule 2c keys on.
      name: "a plaintext admin password constant (the mod4 shape)",
      file: "admin-creds.js",
      body: 'const ADMIN_PASSWORD = "@DELL123dell#";\n',
    },
  ];

  for (const shape of SHAPES) {
    it(`fails on ${shape.name}`, () => {
      writeFileSync(join(rig, shape.file), shape.body);
    const { code, out } = scan();
    rmSync(join(rig, shape.file));
    expect(out, `gate output for ${shape.file}`).toContain("secret gate FAILED");
    if (shape.name.startsWith("credentials embedded in a URL userinfo")) {
      // Name the rule so a future refactor cannot silently drop it while the
      // generic FAILED line still matches.
      expect(out, `userinfo rule label for ${shape.file}`).toContain("URL userinfo");
    }
    if (shape.name.startsWith("a plaintext admin password constant")) {
      // Likewise pin rule 2c's label: mod4's shape must fail as ITS rule,
      // not incidentally via some other pattern.
      expect(out, `password-constant rule label for ${shape.file}`).toContain(
        "password/secret/token constant",
      );
    }
    expect(code).toBe(1);
    });
  }
});

describe("secret gate: credential-shaped filenames are caught", () => {
  const NAMES = ["id_rsa", "credentials.json", "app-secrets.yaml", "app.pem", "bundle.p12"];

  for (const name of NAMES) {
    it(`fails on tracked ${name}`, () => {
      writeFileSync(join(rig, name), "x\n");
      const { code, out } = scan();
      rmSync(join(rig, name));
      expect(out, `gate output for ${name}`).toContain("credential-shaped filenames");
      expect(code).toBe(1);
    });
  }

  it("fails on a tracked .env", () => {
    writeFileSync(join(rig, ".env"), "JWT_SECRET=supersecretvalue1234567890\n");
    const { code, out } = scan();
    rmSync(join(rig, ".env"));
    expect(out).toContain("credential-shaped filenames");
    expect(code).toBe(1);
  });
});

describe("secret gate: the allowlist is the only exemption", () => {
  it("does not flag the allowlisted google-services.json", () => {
    writeFileSync(join(rig, "google-services.json"), '{"api_key":"AIzaSyD-1234567890abcdefghijklmnopqrstu"}\n');
    const { code, out } = scan();
    rmSync(join(rig, "google-services.json"));
    expect(out).toContain("secret gate: clean");
    expect(code).toBe(0);
  });

  it("does not flag the allowlisted web/dist/** tree", () => {
    mkdirSync(join(rig, "web", "dist"), { recursive: true });
    writeFileSync(join(rig, "web", "dist", "a.js"), 'const k="AIzaSyD-1234567890abcdefghijklmnopqrstu";\n');
    const { code } = scan();
    rmSync(join(rig, "web"), { recursive: true, force: true });
    expect(code).toBe(0);
  });

  it("still flags a real secret in a NON-allowlisted file", () => {
    // Guards against the allowlist becoming a blanket suppression: the same key
    // material must be caught everywhere except the paths just justified.
    writeFileSync(join(rig, "not-allowlisted.txt"), "K=AIzaSyD-1234567890abcdefghijklmnopqrstu\n");
    const { code, out } = scan();
    rmSync(join(rig, "not-allowlisted.txt"));
    expect(out).toContain("secret-shaped content");
    expect(code).toBe(1);
  });
});

describe("secret gate: refuses to report a broken scan as clean", () => {
  it("exits 2 (not 0) when the content scan cannot run", () => {
    const gatePath = join(rig, "scripts", "secret-scan.sh");
    const original = execFileSync("bash", ["-c", `cat ${JSON.stringify(gatePath)}`], { encoding: "utf8" });
    // Break the git grep invocation, not the pattern: a mangled pattern can
    // still compile and match nothing, whereas a bad flag is a real error the
    // gate must surface rather than absorb.
    writeFileSync(gatePath, original.replace("git grep -I -n -E -e", "git grep --not-a-flag -e"));
    const res = spawnSync("bash", ["scripts/secret-scan.sh"], { cwd: rig, encoding: "utf8", env: rigEnv });
    writeFileSync(gatePath, original);
    expect(`${res.stdout}${res.stderr}`).toContain("NOT a pass");
    expect(res.status).toBe(2);
  });
});

describe("secret gate: a dead allowlist filter fails closed (ISSUE-107 C1)", () => {
  it("exits 2, not 0, when filter-allowlist.cjs throws", () => {
    const filterPath = join(rig, "scripts", "filter-allowlist.cjs");
    writeFileSync(filterPath, 'throw new Error("filter exploded");\n');
    // Commit AFTER breaking the filter: the gate short-circuits to "nothing to
    // scan" on an empty index, and an uncommitted rig would make this pass or
    // fail for a reason unrelated to the filter.
    git(["add", "-A"]);
    git(["commit", "-q", "--allow-empty", "-m", "rig state"]);
    const res = spawnSync("bash", ["scripts/secret-scan.sh"], { cwd: rig, encoding: "utf8", env: rigEnv });
    // Restore before asserting: a failed assertion must not leave a broken
    // filter behind for every later test in this file.
    cpSync(join(REPO_ROOT, "scripts", "filter-allowlist.cjs"), filterPath);

    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain("allowlist filter did not run");
    expect(out).not.toContain("nothing to scan");
    expect(out).not.toContain("secret gate: clean");
    expect(res.status).toBe(2);
  });

  it("exits 2, not 0, when node itself never runs the filter", () => {
    // The other way the filter dies: node is missing or broken. A stub that
    // exits 127 before reading anything leaves the filtered list empty, which
    // is exactly the state the old `< <(...)` pipeline could not tell apart
    // from a genuinely clean tree. PATH keeps the system entries so git still
    // works and the failure under test is the filter's, not the gate's own
    // plumbing reporting something else.
    const bin = join(rig, "broken-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 127\n");
    chmodSync(join(bin, "node"), 0o755);

    git(["add", "-A"]);
    git(["commit", "-q", "--allow-empty", "-m", "rig state"]);
    const res = spawnSync("bash", ["scripts/secret-scan.sh"], {
      cwd: rig,
      encoding: "utf8",
      env: { ...rigEnv, PATH: `${bin}:${rigEnv.PATH ?? ""}` },
    });
    rmSync(bin, { recursive: true, force: true });

    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain("allowlist filter did not run");
    expect(out).not.toContain("secret gate: clean");
    expect(res.status).toBe(2);
  });
});