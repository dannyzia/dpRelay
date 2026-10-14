const { test, expect } = require('@playwright/test');

/**
 * dP Relay v5 end-to-end suite (ISSUE-99) — modernized from the legacy
 * Firebase v4 smoke test. Targets the React Vite dashboard (AuthScreens,
 * ConnectAppScreen, CampaignsScreen, CreditsScreen, OperatorPanel) and the
 * Fastify /v5 API behind it.
 *
 * Environment (all optional — the suite degrades gracefully without them):
 *   DASHBOARD_URL       where the SPA is served (default in playwright.config.ts)
 *   E2E_APP_ID          X-App-Id of a provisioned app; unlocks the campaigns/
 *   E2E_APP_SECRET     credits/operator plane tests (secret shown once at mint)
 *   E2E_OPERATOR_SECRET unlocks the operator panel (OPERATOR_SECRET)
 *   E2E_ALLOW_MUTATIONS set to "1" to let the campaign-creation test actually
 *                       POST a campaign (needs bulk enabled + credits; it can
 *                       enqueue real SMS, so it is OFF by default)
 *
 * Every run registers fresh users (test_<ts>_<rand>@example.com) so repeat
 * runs never collide on email_taken. The v5 dashboard is a state machine, not
 * a URL router: navigation happens through in-app buttons, so tests drive the
 * UI rather than page.goto()ing sub-routes.
 */

const APP_ID = process.env.E2E_APP_ID;
const APP_SECRET = process.env.E2E_APP_SECRET;
const OPERATOR_SECRET = process.env.E2E_OPERATOR_SECRET;
const ALLOW_MUTATIONS = process.env.E2E_ALLOW_MUTATIONS === '1';

// Server enforces a 10-char minimum (server/src/routes/auth.ts PASSWORD_MIN).
const TEST_PASSWORD = 'E2ePassw0rd!';

/** Fresh identity per call: millisecond stamp + random suffix beats same-ms collisions. */
function uniqueEmail() {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Registers a new user through the RegisterScreen and lands back on sign-in. */
async function registerUser(page, email) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('At least 8 characters').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to sign in' }).click();
}

/** Signs in and waits for the post-login gate (connect-app screen). */
async function signIn(page, email) {
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect an app' })).toBeVisible();
  // The session contract: login stores the JWT pair in localStorage.
  const token = await page.evaluate(() => localStorage.getItem('dprelay.accessToken'));
  expect(token, 'login must store an access token in localStorage').toBeTruthy();
}

/** Pastes app credentials into ConnectAppScreen (verified server-side before store). */
async function connectApp(page) {
  await page.getByPlaceholder('e.g. dprelay-prod-3').fill(APP_ID);
  await page.locator('input[type="password"]').fill(APP_SECRET);
  await page.getByRole('button', { name: 'Connect app' }).click();
}

test.describe('v5 user client flow', () => {
  test('register, sign in, and gate on connect-app', async ({ page }) => {
    const email = uniqueEmail();
    await registerUser(page, email);
    await signIn(page, email);
    // Sign-in with no connected app must land on the connect-app gate, not an error.
    await expect(page.getByRole('button', { name: 'Sign out instead' })).toBeVisible();
  });

  test('rejects bad credentials with a field-level hint', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('you@example.com').fill(uniqueEmail());
    await page.locator('input[type="password"]').fill('definitely-wrong-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  });

  test('connect-app rejects unknown app ids without breaking the session', async ({ page }) => {
    const email = uniqueEmail();
    await registerUser(page, email);
    await signIn(page, email);
    // A bogus id (NOT the provisioned one): requireApp answers unknown_app →
    // the screen maps it to an actionable hint.
    await page.getByPlaceholder('e.g. dprelay-prod-3').fill(`unknown-${Date.now()}`);
    await page.locator('input[type="password"]').fill('definitely-not-a-real-secret-0000');
    await page.getByRole('button', { name: 'Connect app' }).click();
    await expect(page.getByRole('alert')).toHaveText(/Unknown X-App-Id/);
    // The user session survives a failed app connection (planes are independent).
    expect(await page.evaluate(() => localStorage.getItem('dprelay.accessToken'))).toBeTruthy();
  });
});

test.describe('v5 connected app plane', () => {
  test.skip(
    () => !APP_ID || !APP_SECRET,
    'E2E_APP_ID / E2E_APP_SECRET not set — skipping connected-plane tests',
  );

  test.beforeEach(async ({ page }) => {
    const email = uniqueEmail();
    await registerUser(page, email);
    await signIn(page, email);
    await connectApp(page);
    await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
  });

  test('campaigns screen renders the create form and validates E.164', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();
    // Status filters are the campaign list surface.
    for (const filter of ['all', 'queued', 'sending', 'paused', 'completed', 'cancelled']) {
      await expect(page.getByRole('button', { name: filter, exact: true })).toBeVisible();
    }

    // Client-side E.164 validation: a bad number is rejected before any API
    // call, so this is safe to run against a live deployment.
    await page.getByPlaceholder('Campaign name').fill(`e2e-${Date.now()}`);
    await page.getByPlaceholder(/Message \(160 chars/).fill('dP Relay E2E validation probe');
    await page.getByPlaceholder(/Phone numbers, one per line/).fill('12345');
    await page.getByRole('button', { name: 'Create campaign' }).click();
    await expect(page.getByRole('alert')).toHaveText(/Not valid E\.164/);

    if (!ALLOW_MUTATIONS) {
      test.info().annotations.push({
        type: 'note',
        description: 'Real campaign creation skipped (set E2E_ALLOW_MUTATIONS=1 to enable)',
      });
      return;
    }

    // Mutating path (ISSUE-100): the form now runs the F5c preview step
    // before creation, so a bulk-enabled server accepts the campaign
    // (201 Created) instead of refusing with checksum_required.
    await page.getByPlaceholder(/Phone numbers, one per line/).fill('+8801712345678');
    const name = `e2e-mut-${Date.now()}`;
    await page.getByPlaceholder('Campaign name').fill(name);

    // The preview surfaces the recipient count before anything spends credits.
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    await expect(page.getByText(/1 recipient ready to send/)).toBeVisible({ timeout: 15_000 });

    // Creation carries the preview checksum → 201 Created + detail panel opens.
    const created = page.waitForResponse(
      (res) => res.url().endsWith('/v5/bulk/campaigns') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create campaign' }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
  });

  test('credits screen shows balances and the package catalog', async ({ page }) => {
    // Capture the app's own catalog request rather than hardcoding an API
    // origin: playwright.config.ts only pins the dashboard URL, and the API
    // base is baked into the SPA at serve time.
    let catalogPayload = null;
    page.on('response', (res) => {
      if (res.url().includes('/v5/billing/packages') && res.request().method() === 'GET') {
        res
          .json()
          .then((body) => {
            catalogPayload = body;
          })
          .catch(() => {});
      }
    });

    await page.getByRole('button', { name: 'Credits' }).click();
    // exact: "Credits" also substring-matches OTP credits / Bulk credits / Buy credits.
    await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
    // Balance cards resolve to numbers (they render "…" while loading).
    await expect(page.locator('h2:has-text("OTP credits") + p')).toHaveText(/^\d+$/);
    await expect(page.locator('h2:has-text("Bulk credits") + p')).toHaveText(/^\d+$/);
    await expect(page.getByRole('heading', { name: 'Buy credits' })).toBeVisible();

    // ISSUE-106: every catalog row must carry isActive, else the screen's
    // filter drops it and the catalog renders its empty state forever.
    await expect
      .poll(() => (catalogPayload === null ? null : catalogPayload.packages), {
        message: 'catalog response never arrived',
      })
      .not.toBeNull();
    expect(Array.isArray(catalogPayload.packages)).toBe(true);
    expect(catalogPayload.packages.every((p) => p.isActive === true)).toBe(true);

    // AC4: a non-empty catalog must actually render rows — the empty-state
    // text is only acceptable when the API returned nothing.
    const emptyState = page.getByText('No active packages published.');
    if (catalogPayload.packages.length > 0) {
      await expect(emptyState).toHaveCount(0);
      await expect(page.locator('ul.divide-y li')).toHaveCount(catalogPayload.packages.length);
    } else {
      await expect(emptyState).toBeVisible();
    }
  });
});

test.describe('v5 operator panel', () => {
  test.skip(
    () => !APP_ID || !APP_SECRET || !OPERATOR_SECRET,
    'E2E_APP_ID / E2E_APP_SECRET / E2E_OPERATOR_SECRET not set — skipping operator unlock',
  );

  test('unlocks with the operator secret and shows aggregate metrics', async ({ page }) => {
    const email = uniqueEmail();
    await registerUser(page, email);
    await signIn(page, email);
    await connectApp(page);
    await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();

    // Operator nav lives in the connected shell (state machine, not a route).
    await page.getByRole('button', { name: 'Operator' }).click();
    await expect(page.getByRole('heading', { name: 'Operator view' })).toBeVisible();
    await page.getByPlaceholder('OPERATOR_SECRET').fill(OPERATOR_SECRET);
    await page.getByRole('button', { name: 'Unlock' }).click();

    // Unlock probes getAdminMetrics with the secret before trusting it.
    await expect(page.getByText('Aggregate metrics')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Apps', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  });
});
