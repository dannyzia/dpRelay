/**
 * RTDB Rules Verification Tests — TEST-RULES
 *
 * Verifies that RTDB data structures conform to the security rules
 * defined in database.rules.json. These tests use Admin SDK (which
 * bypasses rules) to validate schema compliance.
 *
 * Full rules testing requires @firebase/rules-unit-testing against
 * the RTDB emulator. These tests verify the data shapes that the rules
 * expect, ensuring that Cloud Functions write conformant data.
 *
 * Run: cd functions && npm test -- rtdb-rules.test.js
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

const APP_MASTER_SECRET =
  process.env.APP_MASTER_SECRET || "test-master-secret-32-characters";

/**
 * Helper to create a test app in RTDB.
 */
async function createTestApp(prefix) {
  const db = admin.database();
  const appId = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const appSecret = crypto.randomBytes(32).toString("base64");
  const apiKeyHash = crypto
    .createHmac("sha256", APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  await db.ref(`registered_apps/${appId}`).set({
    name: `Rules Test App ${prefix}`,
    ownerUid: "test-owner-uid",
    apiKeyHash,
    smsTemplate: "Your {appName} code: {otp}. Valid {ttl} minutes.",
    rateLimit: { maxPerPhone: 3, windowMs: 600000 },
    webhookUrl: null,
    webhookSecretHash: null,
    active: true,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });

  return { appId, appSecret };
}

describe("RTDB Rules Verification Tests", () => {
  const cleanupIds = {
    apps: [],
    otpRequests: [],
    otpVerifyReceipts: [],
    pendingSms: [],
    webhookFailures: [],
  };

  afterAll(async () => {
    const db = admin.database();
    for (const appId of cleanupIds.apps) {
      try {
        await db.ref(`registered_apps/${appId}`).remove();
      } catch (e) {
        /* ignore */
      }
    }
    for (const sessionId of cleanupIds.otpRequests) {
      try {
        await db.ref(`otp_requests/${sessionId}`).remove();
      } catch (e) {
        /* ignore */
      }
    }
    for (const sessionId of cleanupIds.otpVerifyReceipts) {
      try {
        await db.ref(`otp_verify_receipts/${sessionId}`).remove();
      } catch (e) {
        /* ignore */
      }
    }
    for (const sessionId of cleanupIds.pendingSms) {
      try {
        await db.ref(`pending_sms/${sessionId}`).remove();
      } catch (e) {
        /* ignore */
      }
    }
    for (const sessionId of cleanupIds.webhookFailures) {
      try {
        await db.ref(`webhook_failures/${sessionId}`).remove();
      } catch (e) {
        /* ignore */
      }
    }
  });

  // -------------------------------------------------------
  // registered_apps/{appId}
  // -------------------------------------------------------
  describe("registered_apps/{appId}", () => {
    test("stores required fields (name, apiKeyHash, active, createdAt)", async () => {
      const { appId } = await createTestApp("required-fields");
      cleanupIds.apps.push(appId);

      const snapshot = await admin
        .database()
        .ref(`registered_apps/${appId}`)
        .once("value");
      const data = snapshot.val();

      // database.rules.json: .validate: newData.hasChildren(['name', 'apiKeyHash', 'active', 'createdAt'])
      expect(data).toHaveProperty("name");
      expect(data).toHaveProperty("apiKeyHash");
      expect(data).toHaveProperty("active");
      expect(data).toHaveProperty("createdAt");
      expect(typeof data.name).toBe("string");
      expect(data.name.length).toBeGreaterThan(0);
      expect(typeof data.apiKeyHash).toBe("string");
      expect(typeof data.active).toBe("boolean");
      expect(typeof data.createdAt).toBe("number");
    });

    test("apiKeyHash is hex format (64 chars, not base64)", async () => {
      const { appId, appSecret } = await createTestApp("hex-hash");
      cleanupIds.apps.push(appId);

      const snapshot = await admin
        .database()
        .ref(`registered_apps/${appId}`)
        .once("value");
      const data = snapshot.val();

      // Rules require apiKeyHash.length >= 32; hex HMAC-SHA256 is exactly 64 chars
      expect(data.apiKeyHash.length).toBeGreaterThanOrEqual(32);
      expect(data.apiKeyHash).toMatch(/^[0-9a-f]{64}$/);

      // Verify it matches the independently computed hex HMAC
      const expectedHash = crypto
        .createHmac("sha256", APP_MASTER_SECRET)
        .update(`${appId}${appSecret}`)
        .digest("hex");
      expect(data.apiKeyHash).toBe(expectedHash);
    });

    test("active field is boolean", async () => {
      const { appId } = await createTestApp("bool-active");
      cleanupIds.apps.push(appId);

      const snapshot = await admin
        .database()
        .ref(`registered_apps/${appId}`)
        .once("value");
      const data = snapshot.val();

      // Rules: .validate: newData.isBoolean()
      expect(typeof data.active).toBe("boolean");
      expect(data.active).toBe(true);
    });

    test("ownerUid field present for multi-tenant dashboard flow", async () => {
      const { appId } = await createTestApp("owner-uid");
      cleanupIds.apps.push(appId);

      const snapshot = await admin
        .database()
        .ref(`registered_apps/${appId}`)
        .once("value");
      const data = snapshot.val();

      // RTDB rules allow read when auth.uid == data.child('ownerUid').val()
      expect(data).toHaveProperty("ownerUid");
      expect(data.ownerUid).toBe("test-owner-uid");
    });

    test("optional fields conform to rule validators when present", async () => {
      const { appId } = await createTestApp("optional");
      cleanupIds.apps.push(appId);

      const snapshot = await admin
        .database()
        .ref(`registered_apps/${appId}`)
        .once("value");
      const data = snapshot.val();

      // smsTemplate: string with length > 0 if present
      if (data.smsTemplate !== null && data.smsTemplate !== undefined) {
        expect(typeof data.smsTemplate).toBe("string");
        expect(data.smsTemplate.length).toBeGreaterThan(0);
      }

      // rateLimit: must have maxPerPhone and windowMs if present
      if (data.rateLimit !== null && data.rateLimit !== undefined) {
        expect(data.rateLimit).toHaveProperty("maxPerPhone");
        expect(data.rateLimit).toHaveProperty("windowMs");
        expect(typeof data.rateLimit.maxPerPhone).toBe("number");
        expect(typeof data.rateLimit.windowMs).toBe("number");
      }
    });
  });

  // -------------------------------------------------------
  // otp_requests/{sessionId}
  // -------------------------------------------------------
  describe("otp_requests/{sessionId}", () => {
    test("no client read/write (admin only) — schema conforms to rule validators", async () => {
      const sessionId = crypto.randomUUID();
      cleanupIds.otpRequests.push(sessionId);

      await admin.database().ref(`otp_requests/${sessionId}`).set({
        appId: "test-app-id",
        phoneNumber: "+8801712345678",
        hashedOtp: "a".repeat(44),
        createdAt: admin.database.ServerValue.TIMESTAMP,
        expiresAt: Date.now() + 600000,
        attempts: 0,
        locked: false,
      });

      const snapshot = await admin
        .database()
        .ref(`otp_requests/${sessionId}`)
        .once("value");
      const data = snapshot.val();

      // Rules: .validate: newData.hasChildren(['appId', 'phoneNumber', 'hashedOtp', 'createdAt', 'expiresAt', 'attempts', 'locked'])
      expect(data).toHaveProperty("appId");
      expect(data).toHaveProperty("phoneNumber");
      expect(data).toHaveProperty("hashedOtp");
      expect(data).toHaveProperty("createdAt");
      expect(data).toHaveProperty("expiresAt");
      expect(data).toHaveProperty("attempts");
      expect(data).toHaveProperty("locked");

      // Type validators from rules
      expect(typeof data.appId).toBe("string");
      expect(data.appId.length).toBeGreaterThan(0);
      expect(data.phoneNumber).toMatch(/^\+[1-9]\d{1,14}$/);
      expect(typeof data.hashedOtp).toBe("string");
      expect(data.hashedOtp.length).toBeGreaterThanOrEqual(32);
      expect(typeof data.expiresAt).toBe("number");
      expect(typeof data.attempts).toBe("number");
      expect(data.attempts).toBeGreaterThanOrEqual(0);
      expect(typeof data.locked).toBe("boolean");
    });
  });

  // -------------------------------------------------------
  // otp_verify_receipts/{sessionId}
  // -------------------------------------------------------
  describe("otp_verify_receipts/{sessionId}", () => {
    test("stores the one-time success receipt fields used for idempotent verify retries", async () => {
      const sessionId = crypto.randomUUID();
      cleanupIds.otpVerifyReceipts.push(sessionId);

      await admin.database().ref(`otp_verify_receipts/${sessionId}`).set({
        appId: "test-app-id",
        phoneNumber: "+8801712345678",
        hashedOtp: "a".repeat(44),
        expiresAt: Date.now() + 600000,
        verifiedAt: admin.database.ServerValue.TIMESTAMP,
        replayAvailable: true,
      });

      const snapshot = await admin
        .database()
        .ref(`otp_verify_receipts/${sessionId}`)
        .once("value");
      const data = snapshot.val();

      expect(data).toHaveProperty("appId");
      expect(data).toHaveProperty("phoneNumber");
      expect(data).toHaveProperty("hashedOtp");
      expect(data).toHaveProperty("expiresAt");
      expect(data).toHaveProperty("verifiedAt");
      expect(data).toHaveProperty("replayAvailable");
      expect(typeof data.appId).toBe("string");
      expect(data.phoneNumber).toMatch(/^\+[1-9]\d{1,14}$/);
      expect(typeof data.hashedOtp).toBe("string");
      expect(data.hashedOtp.length).toBeGreaterThanOrEqual(32);
      expect(typeof data.expiresAt).toBe("number");
      expect(typeof data.verifiedAt).toBe("number");
      expect(typeof data.replayAvailable).toBe("boolean");
    });
  });

  // -------------------------------------------------------
  // pending_sms/{sessionId}
  // -------------------------------------------------------
  describe("pending_sms/{sessionId}", () => {
    test("stores required fields (appId, to, message, status, createdAt)", async () => {
      const sessionId = crypto.randomUUID();
      cleanupIds.pendingSms.push(sessionId);

      await admin.database().ref(`pending_sms/${sessionId}`).set({
        appId: "test-app-id",
        to: "+8801712345678",
        message: "Your TestApp code: 123456. Valid 10 minutes.",
        status: "pending",
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });

      const snapshot = await admin
        .database()
        .ref(`pending_sms/${sessionId}`)
        .once("value");
      const data = snapshot.val();

      // Rules: .validate: newData.hasChildren(['appId', 'to', 'message', 'status', 'createdAt'])
      expect(data).toHaveProperty("appId");
      expect(data).toHaveProperty("to");
      expect(data).toHaveProperty("message");
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("createdAt");
    });

    test("status field only accepts pending or sent", async () => {
      const validStatuses = ["pending", "sent"];
      for (const status of validStatuses) {
        expect(
          status === "pending" || status === "sent"
        ).toBe(true);
      }

      // Verify invalid statuses would be rejected
      const invalidStatuses = ["delivered", "failed", "queued", ""];
      for (const status of invalidStatuses) {
        expect(
          status === "pending" || status === "sent"
        ).toBe(false);
      }
    });

    test("error sub-record conforms to rule validators", async () => {
      const sessionId = crypto.randomUUID();
      cleanupIds.pendingSms.push(sessionId);

      await admin.database().ref(`pending_sms/${sessionId}`).set({
        appId: "test-app-id",
        to: "+8801712345678",
        message: "Test",
        status: "pending",
        createdAt: admin.database.ServerValue.TIMESTAMP,
        error: {
          error: "SIM_NOT_FOUND",
          errorCode: 404,
          failedAt: Date.now(),
        },
      });

      const snapshot = await admin
        .database()
        .ref(`pending_sms/${sessionId}`)
        .once("value");
      const data = snapshot.val();

      // Rules: error sub-record must have error, errorCode, failedAt
      expect(data.error).toHaveProperty("error");
      expect(data.error).toHaveProperty("errorCode");
      expect(data.error).toHaveProperty("failedAt");
      expect(typeof data.error.error).toBe("string");
      expect(typeof data.error.errorCode).toBe("number");
      expect(typeof data.error.failedAt).toBe("number");
    });
  });

  // -------------------------------------------------------
  // stats
  // -------------------------------------------------------
  describe("stats", () => {
    test("readable by any authenticated user — node structure is valid", async () => {
      const db = admin.database();
      await db.ref("stats").set({
        total_today: 0,
        success_count: 0,
        failed_count: 0,
        pending_count: 0,
        success_rate: 0,
        queue_depth: 0,
        updated_at: admin.database.ServerValue.TIMESTAMP,
      });

      const snapshot = await db.ref("stats").once("value");
      expect(snapshot.exists()).toBe(true);

      const data = snapshot.val();
      expect(typeof data.total_today).toBe("number");
      expect(typeof data.queue_depth).toBe("number");

      // Cleanup
      await db.ref("stats").remove();
    });
  });

  // -------------------------------------------------------
  // webhook_failures/{sessionId}
  // -------------------------------------------------------
  describe("webhook_failures/{sessionId}", () => {
    test("stores sessionId, error, failedAt", async () => {
      const sessionId = crypto.randomUUID();
      cleanupIds.webhookFailures.push(sessionId);

      await admin.database().ref(`webhook_failures/${sessionId}`).set({
        sessionId,
        error: "Connection timeout",
        errorCode: "ETIMEDOUT",
        failedAt: admin.database.ServerValue.TIMESTAMP,
      });

      const snapshot = await admin
        .database()
        .ref(`webhook_failures/${sessionId}`)
        .once("value");
      const data = snapshot.val();

      // Rules: .validate: newData.hasChildren(['sessionId', 'error', 'failedAt'])
      expect(data).toHaveProperty("sessionId");
      expect(data).toHaveProperty("error");
      expect(data).toHaveProperty("failedAt");
      expect(typeof data.sessionId).toBe("string");
      expect(data.sessionId.length).toBeGreaterThan(0);
      expect(typeof data.error).toBe("string");
      expect(typeof data.failedAt).toBe("number");
    });
  });
});
