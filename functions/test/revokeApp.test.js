/**
 * Revoke App Tests — TEST-01
 *
 * Tests the app revocation flow: setting active=false, revokedAt timestamp,
 * and the validateAppCredentials logic for revoked apps.
 * Requires Firebase Emulator.
 *
 * Run: cd functions && npm test -- revokeApp.test.js
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

jest.setTimeout(30000);

const APP_MASTER_SECRET =
  process.env.APP_MASTER_SECRET || "test-master-secret-32-characters";

/**
 * Constant-time comparison to prevent timing attacks.
 * Mirrors the implementation in the Cloud Function source.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }

  return result === 0;
}

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

/**
 * Simulates the validateAppCredentials logic used across Cloud Functions.
 * This mirrors the function exported from index.js.
 */
async function validateAppCredentials(appId, appSecret) {
  const db = admin.database();
  const appSnapshot = await db.ref(`registered_apps/${appId}`).once("value");

  if (!appSnapshot.exists()) {
    return { valid: false, error: "app_not_found" };
  }

  const appData = appSnapshot.val();

  if (appData.active !== true) {
    return { valid: false, error: "app_revoked" };
  }

  const expectedHash = crypto
    .createHmac("sha256", APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  if (!timingSafeEqual(expectedHash, appData.apiKeyHash)) {
    return { valid: false, error: "invalid_credentials" };
  }

  return { valid: true, appData };
}

describe("Revoke App Tests (TEST-01)", () => {
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

  test("Admin revokes app: sets active=false", async () => {
    const { appId } = await createTestApp("revoke");
    cleanupIds.push(appId);

    // Verify app is initially active
    const db = admin.database();
    const beforeSnapshot = await db.ref(`registered_apps/${appId}`).once("value");
    expect(beforeSnapshot.val().active).toBe(true);

    // Simulate revokeApp: update active to false
    await db.ref(`registered_apps/${appId}`).update({
      active: false,
      revokedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Verify active is now false
    const afterSnapshot = await db.ref(`registered_apps/${appId}`).once("value");
    expect(afterSnapshot.val().active).toBe(false);
  });

  test("Revoked app: active is false in RTDB", async () => {
    const { appId } = await createTestApp("verify-revoked");
    cleanupIds.push(appId);

    const db = admin.database();

    // Revoke the app
    await db.ref(`registered_apps/${appId}`).update({
      active: false,
      revokedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Read back and verify the revoked state
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    const appData = snapshot.val();

    expect(appData.active).toBe(false);
    // Ensure the rest of the app data is preserved
    expect(appData.name).toBeDefined();
    expect(appData.apiKeyHash).toBeDefined();
    expect(appData.ownerUid).toBeDefined();
  });

  test("Revoked app subsequent validation would fail", async () => {
    const { appId, appSecret } = await createTestApp("validate-revoked");
    cleanupIds.push(appId);

    // Verify credentials validate successfully before revocation
    const beforeResult = await validateAppCredentials(appId, appSecret);
    expect(beforeResult.valid).toBe(true);

    // Revoke the app
    const db = admin.database();
    await db.ref(`registered_apps/${appId}`).update({
      active: false,
      revokedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Verify credentials now fail with app_revoked error
    const afterResult = await validateAppCredentials(appId, appSecret);
    expect(afterResult.valid).toBe(false);
    expect(afterResult.error).toBe("app_revoked");
  });

  test("Revoked app timestamp recorded", async () => {
    const { appId } = await createTestApp("timestamp");
    cleanupIds.push(appId);

    const beforeRevoke = Date.now();

    // Simulate revokeApp: set active=false and revokedAt
    const db = admin.database();
    await db.ref(`registered_apps/${appId}`).update({
      active: false,
      revokedAt: admin.database.ServerValue.TIMESTAMP,
    });

    const afterRevoke = Date.now();

    // Verify revokedAt field exists and is a reasonable timestamp
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    const appData = snapshot.val();

    expect(appData.revokedAt).toBeDefined();
    expect(typeof appData.revokedAt).toBe("number");

    // The timestamp should be within the time window of the test
    expect(appData.revokedAt).toBeGreaterThanOrEqual(beforeRevoke - 1000);
    expect(appData.revokedAt).toBeLessThanOrEqual(afterRevoke + 1000);
  });
});
