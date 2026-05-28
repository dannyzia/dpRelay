/**
 * Regenerate App Secret Tests — TEST-01
 *
 * Tests the app secret regeneration flow: new apiKeyHash written to RTDB,
 * old secret invalidation, and secretRotatedAt timestamp.
 * Uses Firebase Admin SDK directly against the emulator.
 * Requires Firebase Emulator.
 *
 * Run: cd functions && npm test -- regenerateAppSecret.test.js
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

  return { appId, appSecret, apiKeyHash };
}

/**
 * Simulates the credential validation logic.
 * Returns { valid: true, appData } or { valid: false, error: string }.
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

describe("Regenerate App Secret Tests (TEST-01)", () => {
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

  test("Regenerate creates new apiKeyHash in RTDB", async () => {
    const { appId, apiKeyHash: originalHash } = await createTestApp("regen");
    cleanupIds.push(appId);

    // Verify original hash exists
    const db = admin.database();
    const beforeSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    expect(beforeSnapshot.val().apiKeyHash).toBe(originalHash);

    // Simulate regenerateAppSecret: generate new secret and hash
    const newAppSecret = crypto.randomBytes(32).toString("base64");
    const newApiKeyHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newAppSecret}`)
      .digest("hex");

    await db.ref(`registered_apps/${appId}`).update({
      apiKeyHash: newApiKeyHash,
      secretRotatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Verify the hash changed
    const afterSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    const storedHash = afterSnapshot.val().apiKeyHash;

    expect(storedHash).not.toBe(originalHash);
    expect(storedHash).toBe(newApiKeyHash);
  });

  test("New secret validates against new hash (hex digest)", async () => {
    const { appId } = await createTestApp("new-valid");
    cleanupIds.push(appId);

    // Generate a new secret (simulating regeneration)
    const newAppSecret = crypto.randomBytes(32).toString("base64");
    const newApiKeyHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newAppSecret}`)
      .digest("hex");

    const db = admin.database();
    await db.ref(`registered_apps/${appId}`).update({
      apiKeyHash: newApiKeyHash,
      secretRotatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Verify the new secret validates successfully
    const result = await validateAppCredentials(appId, newAppSecret);
    expect(result.valid).toBe(true);

    // Verify the stored hash is hex format
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    const storedHash = snapshot.val().apiKeyHash;
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

    // Independently verify the hex digest matches
    const expectedHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newAppSecret}`)
      .digest("hex");
    expect(timingSafeEqual(storedHash, expectedHash)).toBe(true);
  });

  test("Old secret no longer validates against new hash", async () => {
    const { appId, appSecret: oldAppSecret } =
      await createTestApp("old-invalid");
    cleanupIds.push(appId);

    // Verify old secret initially works
    const beforeResult = await validateAppCredentials(appId, oldAppSecret);
    expect(beforeResult.valid).toBe(true);

    // Regenerate: write a new secret hash
    const newAppSecret = crypto.randomBytes(32).toString("base64");
    const newApiKeyHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newAppSecret}`)
      .digest("hex");

    const db = admin.database();
    await db.ref(`registered_apps/${appId}`).update({
      apiKeyHash: newApiKeyHash,
      secretRotatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Verify the OLD secret no longer validates
    const afterResult = await validateAppCredentials(appId, oldAppSecret);
    expect(afterResult.valid).toBe(false);
    expect(afterResult.error).toBe("invalid_credentials");

    // Verify the NEW secret does validate
    const newResult = await validateAppCredentials(appId, newAppSecret);
    expect(newResult.valid).toBe(true);
  });

  test("secretRotatedAt timestamp updated", async () => {
    const { appId } = await createTestApp("rotate-ts");
    cleanupIds.push(appId);

    const db = admin.database();

    // Verify secretRotatedAt does not exist initially
    const beforeSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    expect(beforeSnapshot.val().secretRotatedAt).toBeUndefined();

    const beforeRotate = Date.now();

    // Simulate regenerateAppSecret
    const newAppSecret = crypto.randomBytes(32).toString("base64");
    const newApiKeyHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${newAppSecret}`)
      .digest("hex");

    await db.ref(`registered_apps/${appId}`).update({
      apiKeyHash: newApiKeyHash,
      secretRotatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    const afterRotate = Date.now();

    // Verify secretRotatedAt field exists and is a reasonable timestamp
    const afterSnapshot = await db
      .ref(`registered_apps/${appId}`)
      .once("value");
    const rotatedAt = afterSnapshot.val().secretRotatedAt;

    expect(rotatedAt).toBeDefined();
    expect(typeof rotatedAt).toBe("number");

    // Timestamp should be within the test execution window
    expect(rotatedAt).toBeGreaterThanOrEqual(beforeRotate - 1000);
    expect(rotatedAt).toBeLessThanOrEqual(afterRotate + 1000);
  });
});
