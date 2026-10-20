import { defineConfig, devices } from "@playwright/test";

/**
 * STAGE F12 (ISSUE-121) — MANUAL production-origin e2e configuration.
 *
 * This suite drives the LIVE customer origin (register → session cookie →
 * email-verification gate → company create → logout → /me 401), so it is a
 * deliberately separate config: CI runs plain `npx playwright test`, which
 * resolves playwright.config.ts, which test-ignores the e2e/production
 * directory, so no CI job can ever reach `e2e/production/`. Nothing here runs
 * on a schedule and nothing here is a required check.
 *
 * Documented MANUAL command (run from the repo root; see the spec header in
 * e2e/production/customer-login.spec.ts for the full two-run procedure).
 * The account values are exported in the shell and never written down:
 *
 *   # Run 1 — register the address, prove the cookie, log out:
 *   export E2E_EMAIL=f12-check@example.com
 *   export E2E_PASSWORD                   # paste a 10+ character throwaway
 *   npx playwright test --config playwright.production.config.ts
 *
 *   # Run 2 — after opening the emailed verification link and copying the
 *   # token out of …/#/verify/<token>:
 *   export E2E_VERIFY_TOKEN               # paste that token
 *   npx playwright test --config playwright.production.config.ts
 *
 *   Without E2E_EMAIL / E2E_PASSWORD every spec in this config SKIPS, so an
 *   accidental invocation never writes to production. The skip, plus the
 *   fact that CI only ever runs plain `npx playwright test` (root config,
 *   production dir test-ignored), is what "MANUAL, never CI" means here.
 *
 * The run is NOT self-contained: registering on production sends a real
 * verification email and company creation is a real production write (it
 * mints a company + app + one-time trial credits under the account you
 * registered).
 *
 * baseURL is the exact customer origin (ISSUE-121 acceptance criteria) — do
 * NOT repoint it at the onrender.com host: different registrable domain means
 * the SameSite=Lax session cookie stops flowing and this suite measures the
 * broken topology instead of the fixed one.
 */
export default defineConfig({
  testDir: "e2e/production",
  // Generous enough for a slow first visit to the real origin; the mailbox
  // step itself happens BETWEEN runs (see the two-run procedure above), never
  // inside one.
  timeout: 420_000,
  expect: { timeout: 15_000 },
  // One production account, one mailbox, real per-IP auth rate budget — never parallel.
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results-production",
  use: {
    // STAGE F12: the exact customer origin. `DASHBOARD_URL` may point it at a
    // staging build of the same SPA; do NOT repoint it at the onrender.com
    // host — different registrable domain means the SameSite=Lax session
    // cookie stops flowing and this suite would measure the broken topology
    // instead of the fixed one.
    baseURL: process.env.DASHBOARD_URL || "https://app.dprelay.digital-papyrus.com",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
