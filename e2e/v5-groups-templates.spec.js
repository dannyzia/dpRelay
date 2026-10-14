const { test, expect } = require('@playwright/test');

/**
 * dP Relay v5 — contact-groups & message-templates plane (ISSUE-101).
 *
 * Successor to the retired e2e/mod4-bulk-sms.spec.js, which targeted the dead
 * Firebase v4 dashboard and carried hardcoded admin credentials. Its VT1/VT2/VT3
 * suites (contact-group CRUD, group detail, template CRUD) are re-expressed here
 * against the real v5 screens
 * (dashboard/src/screens/GroupsScreen.tsx and TemplatesScreen.tsx) — flows
 * that had ZERO e2e coverage until now. The v4-only suites (VT5
 * campaign-with-groups wizard, VT6 load-template-in-campaign, VT7
 * download-report) have no v5 dashboard equivalent; they are tracked as a
 * dashboard feature gap, not test debt.
 *
 * Environment (same contract as full-test.spec.js):
 *   DASHBOARD_URL       where the SPA is served (default in playwright.config.ts)
 *   E2E_APP_ID          X-App-Id of a provisioned app (required to run; the
 *   E2E_APP_SECRET     groups/templates plane is app-scoped via requireApp)
 *
 * Every test creates uniquely-named fixtures (test_<ts>_<rand>) so repeat runs
 * never collide. Dialog flows (prompt for rename, confirm for delete) are
 * handled explicitly via page.on('dialog') — deterministic, no sleeps.
 */

const APP_ID = process.env.E2E_APP_ID;
const APP_SECRET = process.env.E2E_APP_SECRET;

/** Fresh unique name per call: millisecond stamp + random suffix. */
function uniqueName(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Registers a new user through the RegisterScreen and lands back on sign-in. */
async function registerUser(page, email) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('At least 8 characters').fill('E2ePassw0rd!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to sign in' }).click();
}

/** Signs in (fresh dynamic user) and waits for the connect-app gate. */
async function signInFresh(page) {
  const email = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
  await registerUser(page, email);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.locator('input[type="password"]').fill('E2ePassw0rd!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect an app' })).toBeVisible();
}

/** Pastes app credentials and lands on the connected shell. */
async function connectApp(page) {
  await page.getByPlaceholder('e.g. dprelay-prod-3').fill(APP_ID);
  await page.locator('input[type="password"]').fill(APP_SECRET);
  await page.getByRole('button', { name: 'Connect app' }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
}

test.describe('v5 contact groups', () => {
  test.skip(
    () => !APP_ID || !APP_SECRET,
    'E2E_APP_ID / E2E_APP_SECRET not set — skipping app-plane groups tests',
  );

  test.beforeEach(async ({ page }) => {
    await signInFresh(page);
    await connectApp(page);
    await page.getByRole('button', { name: 'Groups' }).click();
    await expect(page.getByRole('heading', { name: 'Contact groups' })).toBeVisible();
  });

  test('creates a group with valid E.164 numbers and lists it', async ({ page }) => {
    const name = uniqueName('grp');
    await page.getByPlaceholder('Group name').fill(name);
    await page.getByPlaceholder(/One or more numbers/).fill('+8801712345678\n+8801712345679');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByText('Group created with 2 numbers')).toBeVisible();
    const row = page.locator('li', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText(/2 numbers/)).toBeVisible();
  });

  test('rejects an empty phone list before any API call', async ({ page }) => {
    await page.getByPlaceholder('Group name').fill(uniqueName('grp'));
    await page.getByRole('button', { name: 'Create group' }).click();
    // Client-side guard: no network request is made for an empty list, so this
    // is safe to run against a live deployment.
    await expect(page.getByText('A group needs a name and at least one phone number')).toBeVisible();
  });

  test('opens group detail and lists its phone numbers', async ({ page }) => {
    const name = uniqueName('grp');
    await page.getByPlaceholder('Group name').fill(name);
    await page.getByPlaceholder(/One or more numbers/).fill('+8801712345679');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByText('Group created with 1 numbers')).toBeVisible();

    const row = page.locator('li', { hasText: name });
    await row.getByRole('button', { name: 'View' }).click();
    // The detail pane renders the members as a newline-joined monospace list.
    await expect(row.getByText('+8801712345679')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Remove numbers…' })).toBeVisible();
  });

  test('renames a group via the prompt dialog', async ({ page }) => {
    const name = uniqueName('grp');
    const renamed = uniqueName('renamed');
    await page.getByPlaceholder('Group name').fill(name);
    await page.getByPlaceholder(/One or more numbers/).fill('+8801712345678');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByText(/Group created with 1 numbers/)).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept(renamed));
    await page.locator('li', { hasText: name }).getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByText('Group renamed')).toBeVisible();
    await expect(page.locator('li', { hasText: renamed })).toBeVisible();
  });

  test('deletes a group after confirm and removes it from the list', async ({ page }) => {
    const name = uniqueName('grp');
    await page.getByPlaceholder('Group name').fill(name);
    await page.getByPlaceholder(/One or more numbers/).fill('+8801712345678');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByText(/Group created with 1 numbers/)).toBeVisible();

    page.once('dialog', (dialog) => {
      // The confirm copy names the group and its size — accept whatever is asked.
      expect(dialog.message()).toContain(name);
      dialog.accept();
    });
    await page.locator('li', { hasText: name }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Group deleted')).toBeVisible();
    await expect(page.locator('li', { hasText: name })).toHaveCount(0);
  });
});

test.describe('v5 message templates', () => {
  test.skip(
    () => !APP_ID || !APP_SECRET,
    'E2E_APP_ID / E2E_APP_SECRET not set — skipping app-plane templates tests',
  );

  test.beforeEach(async ({ page }) => {
    await signInFresh(page);
    await connectApp(page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await expect(page.getByRole('heading', { name: 'Message templates' })).toBeVisible();
  });

  test('creates a template and lists its body', async ({ page }) => {
    const name = uniqueName('tpl');
    const body = `dP Relay body ${name}`;
    await page.getByPlaceholder('Template name').fill(name);
    await page.getByPlaceholder('Message body').fill(body);
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText('Template created')).toBeVisible();
    const row = page.locator('li', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText(body)).toBeVisible();
  });

  test('rejects an empty template before any API call', async ({ page }) => {
    await page.getByPlaceholder('Template name').fill(uniqueName('tpl'));
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText('A template needs a name and a body')).toBeVisible();
  });

  test('edits a template body through the inline editor', async ({ page }) => {
    const name = uniqueName('tpl');
    await page.getByPlaceholder('Template name').fill(name);
    await page.getByPlaceholder('Message body').fill(`original ${name}`);
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText('Template created')).toBeVisible();

    const row = page.locator('li', { hasText: name });
    await row.getByRole('button', { name: 'Edit' }).click();
    // Inline editor: the row swaps to input + textarea (no placeholders) + Save.
    const editBody = row.locator('textarea');
    await editBody.fill(`updated ${name}`);
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Template updated')).toBeVisible();
    await expect(row.getByText(`updated ${name}`)).toBeVisible();
  });

  test('deletes a template after confirm and removes it from the list', async ({ page }) => {
    const name = uniqueName('tpl');
    await page.getByPlaceholder('Template name').fill(name);
    await page.getByPlaceholder('Message body').fill(`body for ${name}`);
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText('Template created')).toBeVisible();

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain(name);
      dialog.accept();
    });
    await page.locator('li', { hasText: name }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Template deleted')).toBeVisible();
    await expect(page.locator('li', { hasText: name })).toHaveCount(0);
  });
});
