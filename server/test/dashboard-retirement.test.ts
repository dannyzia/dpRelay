/**
 * STAGE F12 (ISSUE-121) — VULN-003: `dashboard/` is retired from production.
 *
 * Why this file exists (it replaces `pages-workflow-preflight.test.ts`): the
 * Cloudflare Pages publish workflow was deleted in this stage, so the preflight
 * tests that read it had no subject left — they would fail on a missing file
 * while proving nothing. The risk they guarded against is not gone, it just
 * changed shape: the danger now is dashboard/ quietly GAINING a production
 * deploy path again. Two customer dashboards means two places for a stale,
 * cross-site bundle to keep serving logins that do not work, which is exactly
 * what VULN-003 recorded.
 *
 * So the assertions invert: the deploy path stays gone, the source stays in
 * the repo (reference, not product), and CI keeps building it so the bundle
 * assertions in pr-checks.yml still fire on every PR that touches it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

/** Every workflow file name committed under .github/workflows. */
function workflowFiles(): string[] {
  return readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

describe("dashboard/ production retirement (STAGE F12)", () => {
  it("has no Cloudflare Pages publish workflow anymore", () => {
    expect(existsSync(join(workflowsDir, "dashboard-pages-deploy.yml"))).toBe(false);
    expect(workflowFiles()).not.toContain("dashboard-pages-deploy.yml");
  });

  it("has no remaining workflow that publishes the dashboard SPA", () => {
    // Any workflow that runs wrangler against dashboard/ is a production
    // publish path by another name; none may exist.
    for (const file of workflowFiles()) {
      const body = readFileSync(join(workflowsDir, file), "utf8");
      expect(
        /wrangler[^\n]*pages[^\n]*deploy|pages deploy[^\n]*dashboard/i.test(body),
        `${file} must not publish dashboard/ to production`,
      ).toBe(false);
    }
  });

  it("keeps the dashboard source in the repo as reference, not as a product", () => {
    // Retired from production ≠ deleted: the code stays (the order says so)
    // and its PR-time build gate stays, so the bundle assertions below it in
    // pr-checks.yml still catch an onrender.com fallback sneaking back in.
    expect(existsSync(join(repoRoot, "dashboard", "src", "api.ts"))).toBe(true);
    expect(existsSync(join(repoRoot, "dashboard", "package.json"))).toBe(true);

    const prChecks = readFileSync(join(workflowsDir, "pr-checks.yml"), "utf8");
    expect(prChecks).toContain("dashboard-build:");
    expect(prChecks).toMatch(/if: needs\.changes\.outputs\.dashboard == 'true'/);
  });
});
