import { defineConfig, devices } from "@playwright/test";

/**
 * Root Playwright configuration for the dP Relay v5 end-to-end suite (ISSUE-99).
 *
 * Targets the React Vite dashboard SPA. `DASHBOARD_URL` lets the same spec run
 * against the deployed Cloudflare Pages build or a local `vite dev` server
 * (point VITE_API_BASE_URL at whichever API the dashboard should talk to —
 * the API origin is baked into the dashboard at build/serve time, not here).
 *
 * Only the chromium project is defined: the dashboard is a Chromium-era SPA
 * and adding Firefox/WebKit multiplies flake without changing coverage value.
 */
export default defineConfig({
  testDir: "e2e",
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
    // Ordered default: the live v5 dashboard on Cloudflare Pages.
    baseURL: process.env.DASHBOARD_URL || "https://dprelay-dashboard.pages.dev",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
