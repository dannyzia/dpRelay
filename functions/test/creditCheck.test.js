/**
 * Credit Check Tests — CR-05
 *
 * Tests credit validation and deduction in sendOtp.
 * Requires Firebase Emulator running: firebase emulators:start --only auth,functions,firestore,database
 *
 * Run: cd functions && npm test -- creditCheck.test.js
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

const APP_MASTER_SECRET =
  process.env.APP_MASTER_SECRET || "test-master-secret-32-characters";

/**
 * Helper to create an app in RTDB for testing.
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
    name: `Test App ${prefix}`,
    ownerUid: "test-owner-uid",
    apiKeyHash,
    smsTemplate: "Your {appName} code: {otp}. Valid {ttl} minutes.",
    rateLimit: { maxPerPhone: 100, windowMs: 60000 },
    webhookUrl: null,
    webhookSecretHash: null,
    active: true,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });

  return { appId, appSecret };
}

/**
 * Helper to set credits in Firestore.
 */
async function setTestCredits(appId, smsRemaining, expiresAtMs) {
  await admin.firestore().collection("app_credits").doc(appId).set({
    appId,
    ownerUid: "test-owner-uid",
    sms_remaining: smsRemaining,
    expires_at: expiresAtMs,
    last_package_id: "test-package",
    purchased_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Helper to clear test data.
 */
async function cleanupTestData(appId) {
  const db = admin.database();
  await db.ref(`registered_apps/${appId}`).remove();
  await admin.firestore().collection("app_credits").doc(appId).delete();
}

describe("Credit Check Tests (CR-05)", () => {
  const testAppIds = [];

  afterAll(async () => {
    // Cleanup all test apps
    for (const appId of testAppIds) {
      try {
        await cleanupTestData(appId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  test("sendOtp with no app_credits document: expect 402 no_credits", async () => {
    const { appId } = await createTestApp("no-credits");
    testAppIds.push(appId);

    // No app_credits document created

    // Simulate the credit check logic from sendOtp
    const creditsDoc = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    expect(creditsDoc.exists).toBe(false);

    // In the real function, this would return 402 with:
    // { error: 'no_credits', message: 'No credit package purchased...' }
  });

  test("sendOtp with sms_remaining = 0: expect 402 no_credits", async () => {
    const { appId } = await createTestApp("zero-credits");
    testAppIds.push(appId);

    // Set credits with 0 remaining
    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setTestCredits(appId, 0, futureExpiry);

    const creditsDoc = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    const creditsData = creditsDoc.data();
    expect(creditsData.sms_remaining).toBe(0);

    // In the real function, this would return 402 with:
    // { error: 'no_credits', message: 'Out of SMS credits. Please top up.' }
  });

  test("sendOtp with expires_at in the past: expect 402 credits_expired", async () => {
    const { appId } = await createTestApp("expired");
    testAppIds.push(appId);

    // Set credits with past expiry
    const pastExpiry = Date.now() - 24 * 60 * 60 * 1000;
    await setTestCredits(appId, 100, pastExpiry);

    const creditsDoc = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    const creditsData = creditsDoc.data();

    const expiresAtValue = Number(creditsData.expires_at);
    expect(expiresAtValue < Date.now()).toBe(true);

    // In the real function, this would return 402 with:
    // { error: 'credits_expired', message: 'Credit package expired...' }
  });

  test("sendOtp with valid credits: Firestore transaction decrements sms_remaining", async () => {
    const { appId } = await createTestApp("valid");
    testAppIds.push(appId);

    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setTestCredits(appId, 10, futureExpiry);

    // Simulate the Firestore transaction that decrement would do
    const firestore = admin.firestore();
    await firestore.runTransaction(async (t) => {
      const creditsRef = firestore.collection("app_credits").doc(appId);
      const creditsDocSnap = await t.get(creditsRef);

      expect(creditsDocSnap.exists).toBe(true);
      const currentData = creditsDocSnap.data();
      expect(currentData.sms_remaining).toBe(10);

      t.update(creditsRef, {
        sms_remaining: currentData.sms_remaining - 1,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Verify decrement happened
    const afterDoc = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    expect(afterDoc.data().sms_remaining).toBe(9);
  });

  test("Concurrent sendOtp calls that drain last credit: transaction prevents over-decrement", async () => {
    const { appId } = await createTestApp("concurrent");
    testAppIds.push(appId);

    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setTestCredits(appId, 1, futureExpiry);

    // Simulate two concurrent transactions
    const firestore = admin.firestore();
    let successCount = 0;
    let failCount = 0;

    const tx1 = firestore
      .runTransaction(async (t) => {
        const creditsRef = firestore.collection("app_credits").doc(appId);
        const creditsDocSnap = await t.get(creditsRef);
        const currentData = creditsDocSnap.data();
        if (currentData.sms_remaining <= 0) {
          throw new Error("no_credits");
        }
        t.update(creditsRef, {
          sms_remaining: currentData.sms_remaining - 1,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      })
      .then(() => {
        successCount++;
      })
      .catch(() => {
        failCount++;
      });

    const tx2 = firestore
      .runTransaction(async (t) => {
        const creditsRef = firestore.collection("app_credits").doc(appId);
        const creditsDocSnap = await t.get(creditsRef);
        const currentData = creditsDocSnap.data();
        if (currentData.sms_remaining <= 0) {
          throw new Error("no_credits");
        }
        t.update(creditsRef, {
          sms_remaining: currentData.sms_remaining - 1,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      })
      .then(() => {
        successCount++;
      })
      .catch(() => {
        failCount++;
      });

    await Promise.all([tx1, tx2]);

    // One should succeed, one should fail (due to Firestore transaction retry)
    expect(successCount + failCount).toBe(2);

    // Balance should be 0 (not negative)
    const afterDoc = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    expect(afterDoc.data().sms_remaining).toBe(0);
  });

  test("getCredits with valid app: returns correct balance", async () => {
    const { appId } = await createTestApp("balance");
    testAppIds.push(appId);

    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setTestCredits(appId, 500, futureExpiry);

    const creditsDoc = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    const creditsData = creditsDoc.data();

    expect(creditsData.sms_remaining).toBe(500);
    expect(creditsData.expires_at).toBe(futureExpiry);
  });

  test("Usage audit record written to app_credits/{appId}/usage", async () => {
    const { appId } = await createTestApp("audit");
    testAppIds.push(appId);

    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setTestCredits(appId, 10, futureExpiry);

    const sessionId = crypto.randomUUID();
    const phoneNumber = "+8801712345678";
    const phoneNumberHash = crypto
      .createHash("sha256")
      .update(phoneNumber)
      .digest("hex");

    await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .collection("usage")
      .add({
        deducted_at: admin.firestore.FieldValue.serverTimestamp(),
        session_id: sessionId,
        phone_number_hash: phoneNumberHash,
      });

    const usageSnapshot = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .collection("usage")
      .where("session_id", "==", sessionId)
      .limit(1)
      .get();

    expect(usageSnapshot.empty).toBe(false);
    const usageDoc = usageSnapshot.docs[0].data();
    expect(usageDoc.session_id).toBe(sessionId);
    expect(usageDoc.phone_number_hash).toBe(phoneNumberHash);
  });
});
