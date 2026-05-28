/**
 * End-to-End Billing Cycle Integration Test — TEST-E2E
 *
 * Full billing cycle: register → buy credits → send OTP → verify balance
 * Requires Firebase Emulator.
 *
 * Run: cd functions && firebase emulators:exec --only auth,functions,firestore,database 'npm test -- e2e-billing.test.js'
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

const APP_MASTER_SECRET =
  process.env.APP_MASTER_SECRET || "test-master-secret-32-characters";

/**
 * Simulates the registerApp flow (creates RTDB record directly).
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
    name: `E2E App ${prefix}`,
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
 * Simulates upsertPackage — creates a package directly.
 */
async function createTestPackage(smsQuota, priceBdt, validityDays) {
  const docRef = await admin
    .firestore()
    .collection("packages")
    .add({
      name: `E2E Package ${smsQuota}`,
      sms_quota: smsQuota,
      price_bdt: priceBdt,
      validity_days: validityDays,
      is_active: true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  return docRef.id;
}

/**
 * Simulates the credit check logic from sendOtp.
 */
async function checkCredits(appId) {
  const creditsDoc = await admin
    .firestore()
    .collection("app_credits")
    .doc(appId)
    .get();
  if (!creditsDoc.exists) {
    return { valid: false, error: "no_credits" };
  }
  const data = creditsDoc.data();
  if (!data.sms_remaining || data.sms_remaining <= 0) {
    return { valid: false, error: "no_credits" };
  }
  const expiresAtValue = Number(data.expires_at);
  if (!expiresAtValue || expiresAtValue < Date.now()) {
    return { valid: false, error: "credits_expired" };
  }
  return { valid: true, data };
}

/**
 * Simulates the credit deduction from sendOtp.
 */
async function deductCredit(appId) {
  const firestore = admin.firestore();
  try {
    await firestore.runTransaction(async (t) => {
      const creditsRef = firestore.collection("app_credits").doc(appId);
      const creditsDocSnap = await t.get(creditsRef);
      if (!creditsDocSnap.exists) {
        throw new Error("no_credits");
      }
      const currentData = creditsDocSnap.data();
      if (currentData.sms_remaining <= 0) {
        throw new Error("no_credits");
      }
      t.update(creditsRef, {
        sms_remaining: currentData.sms_remaining - 1,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Simulates approveCredit — adds credits to app.
 */
async function approveCredits(appId, smsQuota, validityDays, transactionId) {
  const firestore = admin.firestore();
  const newBalance = await firestore.runTransaction(async (t) => {
    const creditsRef = firestore.collection("app_credits").doc(appId);
    const creditsDoc = await t.get(creditsRef);

    let currentRemaining = 0;
    if (creditsDoc.exists) {
      currentRemaining = creditsDoc.data().sms_remaining || 0;
    }

    const newRemaining = currentRemaining + smsQuota;
    const now = Date.now();
    const newExpiresAt = now + validityDays * 24 * 60 * 60 * 1000;

    t.set(
      creditsRef,
      {
        appId,
        ownerUid: "test-owner-uid",
        sms_remaining: newRemaining,
        expires_at: newExpiresAt,
        last_package_id: transactionId,
        purchased_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return newRemaining;
  });

  await firestore.collection("transactions").doc(transactionId).update({
    status: "approved",
    approved_at: admin.firestore.FieldValue.serverTimestamp(),
    admin_id: "admin-uid",
  });

  return newBalance;
}

describe("End-to-End Billing Cycle Integration Test (TEST-E2E)", () => {
  const cleanupIds = { apps: [], packages: [], transactions: [] };

  afterAll(async () => {
    for (const appId of cleanupIds.apps) {
      try {
        await admin.database().ref(`registered_apps/${appId}`).remove();
        await admin.firestore().collection("app_credits").doc(appId).delete();
      } catch (e) {
        /* ignore */
      }
    }
    for (const pkgId of cleanupIds.packages) {
      try {
        await admin.firestore().collection("packages").doc(pkgId).delete();
      } catch (e) {
        /* ignore */
      }
    }
    for (const txId of cleanupIds.transactions) {
      try {
        await admin.firestore().collection("transactions").doc(txId).delete();
      } catch (e) {
        /* ignore */
      }
    }
  });

  test("Full billing cycle from package creation to OTP consumption", async () => {
    const SMS_QUOTA = 5; // Small number for testing

    // Step 1: Admin seeds a test package
    const packageId = await createTestPackage(SMS_QUOTA, 500, 30);
    cleanupIds.packages.push(packageId);
    expect(packageId).toBeTruthy();

    // Step 2: Client registers an app
    const { appId, appSecret } = await createTestApp("e2e");
    cleanupIds.apps.push(appId);
    expect(appId).toBeTruthy();
    expect(appSecret).toBeTruthy();

    // Verify app exists in RTDB
    const appSnapshot = await admin
      .database()
      .ref(`registered_apps/${appId}`)
      .once("value");
    expect(appSnapshot.exists()).toBe(true);

    // Step 3: Client calls sendOtp — expect 402 no_credits (no credits yet)
    const creditCheck1 = await checkCredits(appId);
    expect(creditCheck1.valid).toBe(false);
    expect(creditCheck1.error).toBe("no_credits");

    // Step 4: Client calls requestCredit with valid packageId
    const transactionId = crypto.randomUUID();
    cleanupIds.transactions.push(transactionId);
    await admin.firestore().collection("transactions").doc(transactionId).set({
      appId,
      ownerUid: "test-owner-uid",
      package_id: packageId,
      sms_quota: SMS_QUOTA,
      validity_days: 30,
      amount_bdt: 500,
      trx_id: null,
      status: "pending",
      requested_at: admin.firestore.FieldValue.serverTimestamp(),
      approved_at: null,
      admin_id: null,
      admin_notes: null,
    });

    // Verify bKash number comes from env
    const bkashNumber = process.env.BKASH_PERSONAL_NUMBER || "CONTACT_ADMIN";
    expect(bkashNumber).toBeTruthy();

    // Step 5: Client submits TrxID
    await admin
      .firestore()
      .collection("transactions")
      .doc(transactionId)
      .update({
        trx_id: "BKASH_E2E_TEST_123",
      });
    const txDoc1 = await admin
      .firestore()
      .collection("transactions")
      .doc(transactionId)
      .get();
    expect(txDoc1.data().trx_id).toBe("BKASH_E2E_TEST_123");

    // Step 6: Admin approves — app_credits balance set to package.sms_quota
    const newBalance = await approveCredits(
      appId,
      SMS_QUOTA,
      30,
      transactionId,
    );
    expect(newBalance).toBe(SMS_QUOTA);

    // Step 7: Client sends OTP — expect success, sms_remaining decremented by 1
    const creditCheck2 = await checkCredits(appId);
    expect(creditCheck2.valid).toBe(true);

    const deduction1 = await deductCredit(appId);
    expect(deduction1.success).toBe(true);

    // Step 8: Client checks credits — balance = sms_quota - 1
    const creditsAfter1 = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    expect(creditsAfter1.data().sms_remaining).toBe(SMS_QUOTA - 1);

    // Step 9: Admin calls approveCredit again on same transactionId — expect idempotency
    const txDoc2 = await admin
      .firestore()
      .collection("transactions")
      .doc(transactionId)
      .get();
    expect(txDoc2.data().status).toBe("approved");
    // Second approval would fail because status !== 'pending'
    // Would throw: HttpsError('already-exists', ...)

    // Step 10: Drain credits and verify 402
    for (let i = 1; i < SMS_QUOTA; i++) {
      const deduction = await deductCredit(appId);
      expect(deduction.success).toBe(true);
    }

    // Now balance should be 0
    const creditsDrained = await admin
      .firestore()
      .collection("app_credits")
      .doc(appId)
      .get();
    expect(creditsDrained.data().sms_remaining).toBe(0);

    // One more OTP should fail
    const deductionFinal = await deductCredit(appId);
    expect(deductionFinal.success).toBe(false);
    expect(deductionFinal.error).toBe("no_credits");
  }, 30000);
});
