/**
 * STAGE F12 (ISSUE-121) — MANUAL customer-origin end-to-end gate.
 *
 * The audit's login checklist, as a script. It runs against the REAL customer
 * origin because the defect under test only exists there: the session cookie
 * is issued by `api.dprelay.digital-papyrus.com` and read by a page on
 * `app.dprelay.digital-papyrus.com`, and nothing short of a browser on the real
 * origins can prove that pair is same-site. Hence MANUAL — never wired into CI
 * (it creates a real account and spends the production per-IP auth budget).
 *
 * Run (see playwright.production.config.ts for why it needs its own config,
 * and e2e/README.md for the full walkthrough). The account values are exported
 * in the shell, never written down:
 *
 *   # Run 1 — register the address, prove the cookie, log out:
 *   export E2E_EMAIL=f12-check@example.com
 *   export E2E_PASSWORD                   # paste a 10+ character throwaway
 *   npx playwright test --config playwright.production.config.ts
 *
 *   # Then open the verification link from that mailbox, copy the token out of
 *   # …/#/verify/<token>, and Run 2 — the gate flip + company create:
 *   export E2E_VERIFY_TOKEN               # paste that token
 *   npx playwright test --config playwright.production.config.ts
 *
 * Run 1 is repeatable with the same address: an already-registered account
 * falls back to sign-in, and the gate assertion below follows the account's
 * actual verification state instead of assuming a fresh one.
 */
import { expect, test, type Page } from "@playwright/test";

const APP_ORIGIN = process.env.DASHBOARD_URL || "https://app.dprelay.digital-papyrus.com";
const API_ORIGIN = process.env.API_URL || "https://api.dprelay.digital-papyrus.com";
const SESSION_COOKIE = "dp_session";

const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const VERIFY_TOKEN = process.env.E2E_VERIFY_TOKEN ?? "";

/** The run is only meaningful with a throwaway account to drive. */
const credentialsReady = EMAIL !== "" && PASSWORD.length >= 10;
const credentialsSkip =
  "Set E2E_EMAIL (fresh throwaway address) and E2E_PASSWORD (10+ chars) to run against the real customer origin";

/** GET /v5/auth/me as the PAGE sees it — credentialed, so only a travelling cookie gets 200. */
async function meStatusFromPage(page: Page): Promise<number> {
  return page.evaluate(async (api) => {
    const res = await fetch(`${api}/v5/auth/me`, { credentials: "include" });
    return res.status;
  }, API_ORIGIN);
}

/** GET /v5/auth/me as JSON (null when signed out). */
async function meFromPage(page: Page): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return page.evaluate(async (api) => {
    const res = await fetch(`${api}/v5/auth/me`, { credentials: "include" });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }, API_ORIGIN);
}

/**
 * Drives the front door to the signed-in hub (`#/apps`), registering the
 * account first and falling back to sign-in when the address already exists —
 * the server answers a duplicate register with one generic banner, which is
 * also why this helper can be run twice with the same address.
 */
async function registerOrSignIn(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/#/login`);
  await page.getByRole("button", { name: "Create one" }).click();
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  const registered = await page
    .waitForURL(/#\/apps$/, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (registered) return;

  // Duplicate address: one generic banner, no enumeration hint. Switch modes
  // and sign in instead so the check stays repeatable.
  await expect(page.locator("#form-error")).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/#\/apps$/, { timeout: 20_000 });
}

/** Sign-in only — for runs where the account already exists and is verified. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/#/login`);
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/#\/apps$/, { timeout: 20_000 });
}

test.describe("customer origin login (manual, production)", () => {
  test("register lands on #/apps with a same-site session cookie the API actually sees", async ({
    page,
    context,
    request,
  }) => {
    test.skip(!credentialsReady, credentialsSkip);

    await registerOrSignIn(page);
    await expect(page).toHaveURL(/#\/apps$/);
    await expect(page.locator("nav").getByText(EMAIL, { exact: true })).toBeVisible();

    // 1. The cookie exists, on the API subdomain, host-only + Lax + HttpOnly
    //    + Secure. `hostOnly` is what makes it a subdomain-of-one: the API is
    //    its own host, so nothing else on the registrable domain receives it.
    const cookies = await context.cookies(API_ORIGIN);
    const session = cookies.find((c) => c.name === SESSION_COOKIE);
    expect(session, `no ${SESSION_COOKIE} cookie was set on ${API_ORIGIN}`).toBeTruthy();
    expect(session?.sameSite).toBe("Lax");
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect((session?.domain ?? "").replace(/^\./, "")).toBe(new URL(API_ORIGIN).hostname);

    // 2. The cookie is SENT and accepted: a credentialed call issued from the
    //    app origin reaches /me authenticated. This is the whole defect in one
    //    assertion — cross-site it would come back 401 with the cookie blocked.
    expect(await meStatusFromPage(page), "session cookie must travel app -> api").toBe(200);

    // 3. The verify-email gate: production must have mail configured or this
    //    stage's gate cannot be checked at all, so say so plainly.
    const mailRes = await request.get(`${API_ORIGIN}/v5/auth/mail-status`);
    expect(mailRes.ok(), "GET /v5/auth/mail-status must answer").toBeTruthy();
    const mail = (await mailRes.json()) as { configured?: boolean };
    expect(mail.configured, "production must have mail configured for the verify-email gate").toBe(true);

    // Then the gate follows the account's real state: a fresh account is
    // gated, one verified by an earlier run is not (both are correct).
    const me = await meFromPage(page);
    expect(me.status).toBe(200);
    const verified = (me.body?.user as { emailVerifiedAt?: number | null } | undefined)?.emailVerifiedAt ?? null;
    if (verified === null) {
      await expect(page.locator('[data-testid="creation-gated"]')).toBeVisible();
      await expect(page.locator("#companyName")).toBeDisabled();
    } else {
      await expect(page.locator('[data-testid="creation-gated"]')).toHaveCount(0);
    }

    // 4. Logout clears the session server-side: /me must answer 401 from the
    //    same page afterwards.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/#\/login$/);
    expect(await meStatusFromPage(page), "logout must invalidate the session").toBe(401);
    const leftover = (await context.cookies(API_ORIGIN)).find((c) => c.name === SESSION_COOKIE);
    expect(leftover, "the session cookie must be cleared by logout").toBeUndefined();
  });

  test("verify-email link flips the gate and the account can create a company", async ({ page }) => {
    test.skip(!credentialsReady, credentialsSkip);
    test.skip(
      VERIFY_TOKEN === "",
      "Set E2E_VERIFY_TOKEN to the token in the emailed link (…/#/verify/<token>) for this address",
    );

    // The token is single-use and belongs to the account E2E_EMAIL owns; the
    // link is public (no session needed) and re-probes the session on success.
    await page.goto(`${APP_ORIGIN}/#/verify/${encodeURIComponent(VERIFY_TOKEN)}`);
    await expect(page.getByText(/Your email is verified/)).toBeVisible();

    await signIn(page);
    await expect(page).toHaveURL(/#\/apps$/);
    await expect(page.locator('[data-testid="creation-gated"]')).toHaveCount(0);

    // Company create is the first thing the email gate blocks, so it is the
    // proof that the flip really reached the server, not just the banner.
    await page.locator("#companyName").fill("F12 origin check");
    await page.getByRole("button", { name: "Create company" }).click();
    await expect(page.locator('[data-testid="fresh-secret"]')).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/#\/login$/);
    expect(await meStatusFromPage(page)).toBe(401);
  });
});
