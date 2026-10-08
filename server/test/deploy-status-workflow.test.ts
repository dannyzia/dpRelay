/**
 * Deploy-status Render poll regression tests.
 *
 * Why this file exists: deploy-status.yml is the ISSUE-13 recurrence guard. It
 * exists because for 8 commits every test suite was green while production
 * silently served a stale build, so the guard fails when this push's
 * new_commit deploy does not reach live. A guard that reports the wrong cause
 * is barely more useful than one that reports none: an owner sent to fix the
 * deploy chain when the credential was at fault loses another cycle.
 *
 * These assert the *shape* of the poll, not its runtime behaviour — the
 * workflow only runs on pushes to master, so it cannot be exercised end to end.
 * That matches the precedent in pages-workflow-preflight.test.ts and
 * boot-script.test.ts for scripts no suite spawns.
 *
 * The invariant under test is the same one the Pages credential preflight uses:
 * report every distinct problem in one run, classify each cause where it can be
 * observed, and exit exactly once.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "deploy-status.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** The Render-poll step's source, from its `- name:` to the end of the job. */
function pollStep(): string {
  const start = workflow.indexOf("      - name: Check latest Render deploy is live");
  expect(start, "deploy poll step not found").toBeGreaterThan(-1);
  return workflow.slice(start + 1);
}

describe("Deploy Status Render poll", () => {
  it("reports EVERY problem in one run instead of exiting at the first", () => {
    const step = pollStep();
    expect(step).not.toMatch(/^\s*set -eu\s*$/m);
    expect(step).toContain("failures=0");
    // Exactly one terminal exit accumulates everything above it. The old
    // version had `exit 1` inline in the status case AND again after the loop,
    // so an owner could only ever see whichever the loop happened to hit first.
    expect(step.match(/exit 1/g) ?? []).toHaveLength(1);
    expect(step).toContain("this step reports every problem rather than stopping at the first");
  });

  it("separates the HTTP status from the body so an error page is not read as an empty list", () => {
    const step = pollStep();
    // This is the root defect: `curl -sS` piped an HTTP error body straight
    // into jq, which reduced it to "none", which read as "deploy has not
    // appeared yet" and burned the full 10-minute window blaming the deploy
    // chain for what was actually a rejected credential.
    expect(step).toContain("-w '%{http_code}'");
    expect(step).toMatch(/curl[^\n]*-o "\$body_file"/);
    expect(step).toMatch(/http_code="curl_error"/);
  });

  it("names the credential as the credential at fault when Render rejects it", () => {
    const step = pollStep();
    expect(step).toMatch(/401\|403\)/);
    expect(step).toContain("CREDENTIAL AT FAULT IS THE KEY");
    // And it must say what it is NOT, because that is the misdirection being
    // fixed: a bad token is not a broken deploy chain.
    expect(step).toMatch(/NOT a deploy-chain problem/);
  });

  it("distinguishes a wrong service id from a wrong credential", () => {
    const step = pollStep();
    expect(step).toMatch(/404\)/);
    expect(step).toContain("RENDER_SERVICE_ID does not name a service");
  });

  it("treats an HTTP 200 that is not a deploy array as an API failure, not as 'no deploy yet'", () => {
    const step = pollStep();
    // Otherwise jq reduces it to "none" again and the misattribution returns.
    expect(step).toMatch(/jq -e 'type == "array"'/);
    expect(step).toMatch(/not as 'no deploy yet'/);
  });

  it("reports its findings as separate blocks, not an elif chain", () => {
    const step = pollStep();
    // An owner with a bad credential also does not have a verified deploy.
    // One elif chain would surface the first and send them round again.
    const findings = step.slice(step.indexOf("# Deliberately NOT an if/elif chain"));
    expect(findings).toContain('if [ -n "$api_problem" ]');
    expect(findings).toContain('if [ -n "$terminal_status" ]');
    expect(findings).toContain('if [ "$saw_deploy_for_target" -eq 0 ]');
    expect(findings).not.toMatch(/^\s*(el)?if .+\n\s*.*fi\n\s*(el)?if \[ -n "\$api_problem/m);
  });

  it("still refuses to accept a previous commit's live deploy as evidence", () => {
    const step = pollStep();
    // The pass condition from ISSUE-13: a *previous* commit being live proves
    // nothing about this push, so a mismatch must keep waiting rather than pass.
    expect(step).toContain('if [ "$COMMIT" != "$TARGET_SHA" ]');
    expect(step).toMatch(/live\) rm -f "\$body_file"; echo "Deploy is live\."; exit 0/);
  });

  it("still names every terminal deploy status as a failure", () => {
    const step = pollStep();
    for (const status of ["update_failed", "create_failed", "build_failed", "canceled", "deactivated"]) {
      expect(step, `${status} must be handled`).toContain(status);
    }
    expect(step).toMatch(/reached terminal status/);
  });

  it("never echoes the API key while still naming the identifiers", () => {
    const step = pollStep();
    const keyEchoes = step.match(/echo[^\n]*\$\{RENDER_API_KEY\}/g);
    expect(keyEchoes ?? []).toEqual([]);
    // The key may appear solely inside an Authorization header.
    expect(step).toContain('-H "Authorization: Bearer $RENDER_API_KEY"');
  });

  it("cleans up its temp file on both the live and the failing exit", () => {
    const step = pollStep();
    // An abandoned temp file is trivial on a CI runner but it is the same class
    // of half-finished path that makes the next reader distrust the step.
    expect(step.match(/rm -f "\$body_file"/g) ?? []).toHaveLength(2);
  });
});