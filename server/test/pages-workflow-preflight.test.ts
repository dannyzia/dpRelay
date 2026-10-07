/**
 * Cloudflare Pages preflight regression tests.
 *
 * Why this file exists: the Pages publish is the only leg of the dashboard
 * chain that CI can run unattended, and its failure mode was a blind one. The
 * preflight originally checked ONE of the three secrets for presence and exited
 * on the first failure, so an owner with several bad secrets discovered them one
 * round trip at a time — the blind dispatch cycles that ran
 * 36981226537…37092682243 before the first preflight existed.
 *
 * These assert the *shape* of the preflight, not its runtime behaviour: the
 * workflow is only executed on master pushes, so it cannot be tested end to end.
 * That matches the precedent in boot-script.test.ts for a script no suite
 * spawns. The assertions are deliberately narrow — they pin the properties that
 * make the failure actionable, so a future refactor cannot quietly reintroduce
 * "which credential is wrong?" ambiguity.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "dashboard-pages-deploy.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** The preflight step's source, from its `- name:` to the next step. */
function preflightStep(): string {
  const start = workflow.indexOf('      - name: "Preflight');
  expect(start, "preflight step not found").toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {6}- (?:name|uses):/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("Pages workflow Cloudflare preflight", () => {
  it("runs before wrangler publishes", () => {
    const preflightAt = workflow.indexOf('      - name: "Preflight');
    const publishAt = workflow.indexOf("      - name: Publish to Cloudflare Pages");
    expect(preflightAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(publishAt);
  });

  it("passes ALL THREE secrets into the step, not just the token", () => {
    const step = preflightStep();
    // The job-level HAS_CLOUDFLARE predicate only tests the token, so the other
    // two arrive with no presence check at all unless the step does it.
    for (const secret of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_PAGES_PROJECT"]) {
      expect(step, `${secret} must reach the preflight`).toContain(`secrets.${secret}`);
    }
  });

  it("presence-checks every secret by name, so a missing one is named not guessed", () => {
    const step = preflightStep();
    expect(step).toMatch(/for var in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_PAGES_PROJECT/);
    expect(step).toContain("is unset or empty");
  });

  it("reports EVERY problem in one run instead of exiting at the first", () => {
    const step = preflightStep();
    // `set -eu` plus an early `exit 1` is the blind-dispatch shape.
    expect(step).not.toMatch(/^\s*set -eu\s*$/m);
    expect(step).toContain("failures=0");
    // Exactly one terminal exit: every check above it accumulates.
    expect(step.match(/exit 1/g) ?? []).toHaveLength(1);
    expect(step).toContain("this step reports every problem");
  });

  it("names the token as the credential at fault when Cloudflare rejects it", () => {
    const step = preflightStep();
    expect(step).toContain("CREDENTIAL AT FAULT IS THE TOKEN");
    // And it must not overclaim: the API cannot narrow the cause further.
    expect(step).toMatch(/cannot be separated from here|identical code for every rejected form/);
  });

  it("reads the ACCOUNT before the token, so one call can settle both", () => {
    const step = preflightStep();
    // ADR-018. /user/tokens/verify can only ever speak about the token, so
    // leading with it spends a round trip to learn what the account read gives
    // for free. If this ever flips back, the reason is in the ADR, not in taste.
    const accountAt = step.indexOf("acct_resp=$(curl");
    const tokenAt = step.indexOf("token_resp=$(curl");
    expect(accountAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(-1);
    expect(accountAt).toBeLessThan(tokenAt);
    // A successful account read also proves the token was accepted - Cloudflare
    // cannot return success:true for a bearer it rejected. Strip the shell
    // comments first: the reasoning between the two assignments is prose, and
    // the claim under test is about the code, not how many lines the note is.
    const codeOnly = step.replace(/#[^\n]*/g, "");
    expect(codeOnly).toMatch(/account_ok=1\s*\n\s*token_ok=1/);
  });

  it("skips the token check when the account read already settled it", () => {
    const step = preflightStep();
    // The invariant is unchanged, only its direction: never report a
    // consequence as if it were a cause, or the owner fixes the wrong secret.
    // Two settles now qualify - the account answered, or the account read
    // already reported the token as rejected and a re-run would restate it.
    expect(step).toMatch(/if \[ "\$account_ok" -eq 1 \]; then[\s\S]*?token check SKIPPED/);
    expect(step).toMatch(/elif \[ "\$token_rejected" -eq 1 \]; then[\s\S]*?token check SKIPPED/);
    // The old gate keyed on token_ok no longer exists in this direction.
    expect(step).not.toContain("account check SKIPPED");
  });

  it("does not double-report one token rejection across both probes", () => {
    const step = preflightStep();
    // A 6003/6111 seen by the account probe is the same fault the token probe
    // would report. Without the flag, one broken token would produce two
    // errors pointing at the same secret.
    expect(step).toMatch(/\*6003\*\|\*6111\*\)[\s\S]{0,200}token_rejected=1/);
  });

  it("does NOT fail a legitimate first publish when the Pages project is absent", () => {
    const step = preflightStep();
    // wrangler creates the project on first publish, so 404 is the expected
    // state. Failing here would block the very deploy the chain is waiting on.
    const notFound = step.slice(step.indexOf("404)"), step.indexOf("404)") + 120);
    expect(notFound).toMatch(/does not exist yet/);
    expect(notFound).not.toContain("note_fail");
  });

  it("fails on an explicit Pages-permission denial with an actionable fix", () => {
    const step = preflightStep();
    expect(step).toMatch(/401\|403\)/);
    expect(step).toContain("Cloudflare Pages -> Edit");
  });

  it("treats an unrecognised Pages status as a warning, not a hard stop", () => {
    // The 401/403 mapping is inferred from observed behaviour, not documented.
    // Guessing wrong must not block a legitimate deploy.
    const step = preflightStep();
    expect(step).toContain("::warning::unexpected HTTP");
    expect(step).toMatch(/not treated as a failure, proceeding to wrangler/);
  });

  it("never echoes the API token, while still naming the identifiers", () => {
    const step = preflightStep();
    // CLOUDFLARE_API_TOKEN is the only real credential here and may appear
    // solely inside an Authorization header. CLOUDFLARE_ACCOUNT_ID and
    // CLOUDFLARE_PAGES_PROJECT are identifiers, and echoing them in the error
    // text is deliberate — it is how the owner learns WHICH value is wrong.
    const tokenEchoes = step.match(/echo[^\n]*\$\{CLOUDFLARE_API_TOKEN\}/g);
    expect(tokenEchoes ?? []).toEqual([]);
    // The account id must still be named, or "which credential?" is unanswered.
    expect(step).toContain("${CLOUDFLARE_ACCOUNT_ID}");
  });
});
