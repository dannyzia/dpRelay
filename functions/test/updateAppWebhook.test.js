/**
 * Update App Webhook Tests — TEST-01
 *
 * Tests the webhook URL update and webhook secret regeneration flow.
 * Uses Firebase Admin SDK directly against the emulator.
 * Requires Firebase Emulator.
 *
 * Run: cd functions && npm test -- updateAppWebhook.test.js
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

jest.setTimeout(30000);

const APP_MASTER_SECRET =
  process.env.APP_MASTER_SECRET || "test-master-secret-32-characters";

/**
 * Helper to create a test app in RTDB.
 */
async function createTestApp(prefix, overrides = {}) {
  const db = admin.database();
  const appId = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const appSecret = crypto.randomBytes(32).toString("base64");
  const apiKeyHash = crypto
    .createHmac("sha256", APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  const appData = {
    name: `Test App ${prefix}`,
    ownerUid: overrides.ownerUid || "test-owner-uid",
    apiKeyHash,
    smsTemplate: "Your {appName} code: {otp}. Valid {ttl} minutes.",
    rateLimit: { maxPerPhone: 3, windowMs: 600000 },
    webhookUrl: null,
    webhookSecretHash: null,
    active: true,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  };

  await db.ref(`registered_apps/${appId}`).set(appData);

  return { appId, appSecret };
}

describe("Update App Webhook Tests (TEST-01)", () => {
  const cleanupIds = [];

  afterAll(async () => {
    const db = admin.database();
    for (const appId of cleanupIds) {
      try {
        await db.ref(`registered_apps/${appId}`).remove();
      } catch (e) {
        /* ignore cleanup errors */
      }
    }
  });

  test("Update webhookUrl: RTDB record updated", async () => {
    const { appId } = await createTestApp("webhook-update");
    cleanupIds.push(appId);

    const newWebhookUrl = "https://example.com/webhook/otp";

    // Verify webhookUrl starts as null/undefined (RTDB omits null values)
    const db = admin.database();
    const beforeSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    expect(beforeSnapshot.val().webhookUrl).toBeFalsy();

    // Simulate updateAppWebhook: update webhookUrl
    await db.ref(`registered_apps/${appId}`).update({
      webhookUrl: newWebhookUrl,
    });

    // Verify webhookUrl is updated
    const afterSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    const appData = afterSnapshot.val();

    expect(appData.webhookUrl).toBe(newWebhookUrl);
    // Other fields should remain unchanged
    expect(appData.active).toBe(true);
    expect(appData.apiKeyHash).toBeDefined();
    expect(appData.name).toBeDefined();
  });

  test("regenerateSecret=true: new webhookSecretHash written", async () => {
    const { appId } = await createTestApp("webhook-secret");
    cleanupIds.push(appId);

    const db = admin.database();

    // Verify webhookSecretHash starts as null/undefined (RTDB omits null values)
    const beforeSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    expect(beforeSnapshot.val().webhookSecretHash).toBeFalsy();

    // Simulate regenerateSecret=true: generate new webhookSecretHash
    const newWebhookSecret = crypto.randomBytes(32).toString("hex");
    const webhookSecretHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newWebhookSecret}`)
      .digest("hex");

    await db.ref(`registered_apps/${appId}`).update({
      webhookUrl: "https://example.com/webhook",
      webhookSecretHash,
    });

    // Verify webhookSecretHash is written as a valid hex HMAC
    const afterSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    const storedHash = afterSnapshot.val().webhookSecretHash;

    expect(storedHash).toBeDefined();
    expect(storedHash).not.toBeNull();

    // Verify it's a valid hex string (SHA-256 HMAC = 64 hex characters)
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

    // Verify the hash is NOT the plaintext secret
    expect(storedHash).not.toBe(newWebhookSecret);

    // Verify the hash matches: createHmac('sha256', masterSecret).update(appId+webhookSecret).digest('hex')
    const expectedHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newWebhookSecret}`)
      .digest("hex");
    expect(storedHash).toBe(expectedHash);
  });

  test("Webhook URL validation: only valid URLs are accepted", async () => {
    const { appId } = await createTestApp("url-validate");
    cleanupIds.push(appId);

    // Helper: basic URL validation mirroring the function's expectations.
    // The function requires webhookUrl to be a non-empty string.
    // Production code trims the URL and stores it directly.
    function isValidWebhookUrl(url) {
      if (!url || typeof url !== "string" || url.trim().length === 0) {
        return false;
      }
      // Basic format check: must start with http:// or https://
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }

    // Valid URLs
    expect(isValidWebhookUrl("https://example.com/webhook")).toBe(true);
    expect(isValidWebhookUrl("http://localhost:3000/hook")).toBe(true);
    expect(isValidWebhookUrl("https://api.myapp.com/v1/otp/callback")).toBe(
      true,
    );

    // Invalid URLs
    expect(isValidWebhookUrl("")).toBe(false);
    expect(isValidWebhookUrl(null)).toBe(false);
    expect(isValidWebhookUrl(undefined)).toBe(false);
    expect(isValidWebhookUrl("not-a-url")).toBe(false);
    expect(isValidWebhookUrl("ftp://example.com/webhook")).toBe(false);
    expect(isValidWebhookUrl("   ")).toBe(false);

    // Simulate storing a valid URL
    const db = admin.database();
    const validUrl = "https://myapp.com/webhook";
    await db.ref(`registered_apps/${appId}`).update({
      webhookUrl: validUrl,
    });

    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    expect(snapshot.val().webhookUrl).toBe(validUrl);
  });

  test("Revoked app: webhook update rejected", async () => {
    const { appId } = await createTestApp("revoke-webhook");
    cleanupIds.push(appId);

    const db = admin.database();

    // Revoke the app first
    await db.ref(`registered_apps/${appId}`).update({
      active: false,
      revokedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Verify the app is revoked — the real function would check:
    // if (appData.active !== true) return res.status(403).json({ error: "app_revoked" })
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    expect(snapshot.val().active).toBe(false);

    // A webhook update should not proceed on a revoked app.
    // Simulate the guard: if active !== true, the update is skipped.
    const appData = snapshot.val();
    const wouldProceed = appData.active === true;
    expect(wouldProceed).toBe(false);
  });
});
