import { defineConfig, devices } from "@playwright/test";

/**
 * Root Playwright configuration for the dP Relay v5 end-to-end suite (ISSUE-99).
 *
 * Targets the React Vite dashboard SPA. `DASHBOARD_URL` lets the same spec run
 * against a deployed build or a local `vite dev` server (point the API-base env
 * var at whichever API the dashboard should talk to — the API origin is baked
 * into the dashboard at build/serve time, not here).
 *
 * STAGE F12 (ISSUE-121): the default baseURL is now the REAL customer origin,
 * `https://app.dprelay.digital-papyrus.com`, because that is the deployment
 * this stage exists to protect — a bare local `npx playwright test` used to
 * fall back to the retired pages.dev dashboard. CI overrides it with
 * DASHBOARD_URL (its own localhost stack), so the default only decides where an
 * unconfigured run lands.
 *
 * `e2e/production/` is deliberately EXCLUDED here: that suite drives live
 * production (real accounts, real per-IP auth rate budget), so it runs only via
 * its own documented command — `npx playwright test --config
 * playwright.production.config.ts` — and can never be reached by the CI job
 * that invokes plain `npx playwright test`.
 *
 * Only the chromium project is defined: the dashboard is a Chromium-era SPA
 * and adding Firefox/WebKit multiplies flake without changing coverage value.
 */
export default defineConfig({
  testDir: "e2e",
  testIgnore: ["**/production/**"],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Serial by default: the suite registers/logs in against a shared API whose
  // auth endpoints are rate-limited per IP (AUTH_RATE_MAX_PER_HOUR), so
  // parallel workers would both slow the API down and risk 429 flake.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    // Ordered default: the live customer dashboard (STAGE F12 re-target; was
    // the retired Cloudflare Pages build).
    baseURL: process.env.DASHBOARD_URL || "https://app.dprelay.digital-papyrus.com",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
