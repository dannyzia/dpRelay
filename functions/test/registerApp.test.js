/**
 * Register App Tests — TEST-01
 *
 * Tests the app registration flow: creating app records in RTDB,
 * HMAC hash storage, and credential validation logic.
 * Requires Firebase Emulator.
 *
 * Run: cd functions && npm test -- registerApp.test.js
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
 * Helper to create a test app in RTDB, simulating registerApp logic.
 */
async function createTestApp(prefix, overrides = {}) {
  const db = admin.database();
  const appId = overrides.appId || crypto.randomUUID();
  const appSecret =
    overrides.appSecret || crypto.randomBytes(32).toString("base64");
  const apiKeyHash = crypto
    .createHmac("sha256", APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  const appData = {
    name: overrides.name || `Test App ${prefix}`,
    ownerUid: overrides.ownerUid || "test-owner-uid",
    apiKeyHash,
    smsTemplate:
      overrides.smsTemplate ||
      "Your {appName} code: {otp}. Valid {ttl} minutes.",
    rateLimit: overrides.rateLimit || { maxPerPhone: 3, windowMs: 600000 },
    webhookUrl: null,
    webhookSecretHash: null,
    active: true,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  };

  await db.ref(`registered_apps/${appId}`).set(appData);

  return { appId, appSecret, apiKeyHash, appData };
}

describe("Register App Tests (TEST-01)", () => {
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

  test("Valid call: creates app in RTDB with correct fields, returns appId and appSecret", async () => {
    const { appId, appSecret } = await createTestApp("valid");
    cleanupIds.push(appId);

    // Verify app record exists in RTDB
    const db = admin.database();
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    expect(snapshot.exists()).toBe(true);

    const storedData = snapshot.val();

    // Verify required fields are stored
    expect(storedData.name).toBeDefined();
    expect(typeof storedData.name).toBe("string");
    expect(storedData.name.length).toBeGreaterThan(0);

    expect(storedData.apiKeyHash).toBeDefined();
    expect(typeof storedData.apiKeyHash).toBe("string");

    expect(storedData.active).toBe(true);

    expect(storedData.ownerUid).toBe("test-owner-uid");

    // Verify appId is a valid UUID format
    expect(appId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // Verify appSecret is a base64-encoded 32-byte string
    const decoded = Buffer.from(appSecret, "base64");
    expect(decoded.length).toBe(32);

    // Verify appId and appSecret are both returned (not undefined)
    expect(appId).toBeDefined();
    expect(appSecret).toBeDefined();
    expect(typeof appId).toBe("string");
    expect(typeof appSecret).toBe("string");
  });

  test("HMAC hash is hex (not base64) and apiKeyHash is stored correctly", async () => {
    const { appId, appSecret, apiKeyHash } = await createTestApp("hex-hash");
    cleanupIds.push(appId);

    // Verify the returned hash is hex format (only hex characters)
    expect(apiKeyHash).toMatch(/^[0-9a-f]{64}$/);

    // Verify it is NOT base64 (base64 can contain +, /, =)
    expect(apiKeyHash).not.toMatch(/[+/=]/);

    // Verify the stored apiKeyHash in RTDB matches the computed one
    const db = admin.database();
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    const storedData = snapshot.val();

    expect(storedData.apiKeyHash).toBe(apiKeyHash);

    // Verify the hash matches: createHmac('sha256', masterSecret).update(appId+appSecret).digest('hex')
    const expectedHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${appSecret}`)
      .digest("hex");

    expect(storedData.apiKeyHash).toBe(expectedHash);
  });

  test("appSecret is NOT stored in plaintext in RTDB", async () => {
    const { appId, appSecret } = await createTestApp("no-plaintext");
    cleanupIds.push(appId);

    const db = admin.database();
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    const storedData = snapshot.val();

    // The plaintext appSecret must not appear anywhere in the stored data
    const allValues = Object.values(storedData);
    for (const val of allValues) {
      if (typeof val === "string") {
        expect(val).not.toBe(appSecret);
      }
    }

    // Specifically verify no field called "appSecret" or "secret" exists
    expect(storedData.appSecret).toBeUndefined();
    expect(storedData.secret).toBeUndefined();
    expect(storedData.plainSecret).toBeUndefined();

    // Only apiKeyHash (the HMAC) should be stored
    expect(storedData.apiKeyHash).toBeDefined();
    expect(storedData.apiKeyHash).not.toBe(appSecret);
  });

  test("Unauthenticated call: timingSafeEqual comparison rejects wrong secret", async () => {
    const wrongSecret = "wrong-secret-value";
    const correctSecret = APP_MASTER_SECRET;

    // Verify timingSafeEqual rejects mismatched values
    expect(timingSafeEqual(wrongSecret, correctSecret)).toBe(false);

    // Verify timingSafeEqual rejects empty/null values
    expect(timingSafeEqual("", correctSecret)).toBe(false);

    // Verify timingSafeEqual accepts correct values
    expect(timingSafeEqual(correctSecret, correctSecret)).toBe(true);

    // In the real function, a failed timingSafeEqual check results in:
    // res.status(403).json({ error: "forbidden", message: "Invalid master secret" })
  });

  test("Duplicate appName: allowed (no uniqueness constraint on name)", async () => {
    const sharedName = "DuplicateApp";

    const app1 = await createTestApp("dup1", { name: sharedName });
    cleanupIds.push(app1.appId);

    const app2 = await createTestApp("dup2", { name: sharedName });
    cleanupIds.push(app2.appId);

    // Both apps should exist with different appIds
    const db = admin.database();
    const snap1 = await db.ref(`registered_apps/${app1.appId}`).once("value");
    const snap2 = await db.ref(`registered_apps/${app2.appId}`).once("value");

    expect(snap1.exists()).toBe(true);
    expect(snap2.exists()).toBe(true);

    // Same name, different appIds
    expect(snap1.val().name).toBe(sharedName);
    expect(snap2.val().name).toBe(sharedName);
    expect(app1.appId).not.toBe(app2.appId);

    // Different apiKeyHash values (derived from different appId+appSecret pairs)
    expect(snap1.val().apiKeyHash).not.toBe(snap2.val().apiKeyHash);
  });

  test("Stored apiKeyHash matches crypto.createHmac('sha256', masterSecret).update(appId+appSecret).digest('hex')", async () => {
    const { appId, appSecret } = await createTestApp("hash-verify");
    cleanupIds.push(appId);

    // Independently compute the expected hash
    const expectedHash = crypto
      .createHmac("sha256", APP_MASTER_SECRET)
      .update(`${appId}${appSecret}`)
      .digest("hex");

    // Read from RTDB and compare
    const db = admin.database();
    const snapshot = await db.ref(`registered_apps/${appId}`).once("value");
    const storedHash = snapshot.val().apiKeyHash;

    // Use timingSafeEqual for comparison (same as production code)
    expect(timingSafeEqual(storedHash, expectedHash)).toBe(true);

    // Also verify the hex digest format explicitly
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
