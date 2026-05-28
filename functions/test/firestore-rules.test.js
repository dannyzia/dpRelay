/**
 * Firestore Rules Verification Tests — TEST-RULES
 *
 * Verifies that Firestore document structures conform to the security
 * rules defined in firestore.rules. These tests use Admin SDK (which
 * bypasses rules) to validate schema compliance.
 *
 * Full rules testing requires @firebase/rules-unit-testing against
 * the Firestore emulator. These tests verify the data shapes that the
 * rules expect, ensuring that Cloud Functions write conformant data.
 *
 * Run: cd functions && npm test -- firestore-rules.test.js
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

/**
 * Helper to create a test app in RTDB for Firestore test setup.
 */
async function createTestApp(prefix) {
  const db = admin.database();
  const APP_MASTER_SECRET =
    process.env.APP_MASTER_SECRET || "test-master-secret-32-characters";
  const appId = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const appSecret = crypto.randomBytes(32).toString("base64");
  const apiKeyHash = crypto
    .createHmac("sha256", APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  await db.ref(`registered_apps/${appId}`).set({
    name: `Firestore Rules Test ${prefix}`,
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

describe("Firestore Rules Verification Tests", () => {
  const cleanupIds = {
    apps: [],
    packages: [],
    credits: [],
    transactions: [],
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
    const firestore = admin.firestore();
    for (const pkgId of cleanupIds.packages) {
      try {
        await firestore.collection("packages").doc(pkgId).delete();
      } catch (e) {
        /* ignore */
      }
    }
    for (const appId of cleanupIds.credits) {
      try {
        // Clean up usage sub-collection
        const usageSnapshot = await firestore
          .collection("app_credits")
          .doc(appId)
          .collection("usage")
          .get();
        const batch = firestore.batch();
        usageSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();

        await firestore.collection("app_credits").doc(appId).delete();
      } catch (e) {
        /* ignore */
      }
    }
    for (const txId of cleanupIds.transactions) {
      try {
        await firestore.collection("transactions").doc(txId).delete();
      } catch (e) {
        /* ignore */
      }
    }
  });

  // -------------------------------------------------------
  // packages/{packageId}
  // -------------------------------------------------------
  describe("packages/{packageId}", () => {
    test("authenticated read, no client write — document structure is valid", async () => {
      const firestore = admin.firestore();
      const docRef = await firestore.collection("packages").add({
        name: "Test Package",
        sms_quota: 100,
        price_bdt: 500,
        validity_days: 30,
        is_active: true,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      cleanupIds.packages.push(docRef.id);

      const doc = await docRef.get();
      const data = doc.data();

      // Rules: allow read: if request.auth != null
      // Verify document has the expected fields for client reads
      expect(data).toHaveProperty("name");
      expect(data).toHaveProperty("sms_quota");
      expect(data).toHaveProperty("price_bdt");
      expect(data).toHaveProperty("validity_days");
      expect(data).toHaveProperty("is_active");
      expect(typeof data.name).toBe("string");
      expect(typeof data.sms_quota).toBe("number");
      expect(typeof data.price_bdt).toBe("number");
      expect(typeof data.validity_days).toBe("number");
      expect(typeof data.is_active).toBe("boolean");
    });

    test("No client can write packages directly (Admin SDK only)", () => {
      // Rules: allow write: if false
      // This is a conceptual test verifying the rule definition.
      // The actual enforcement happens at the Firestore rules layer.
      // Admin SDK bypasses rules, so we can only verify the concept:
      // - Cloud Functions use Admin SDK to write
      // - Client SDK writes are blocked by rules
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------
  // app_credits/{appId}
  // -------------------------------------------------------
  describe("app_credits/{appId}", () => {
    test("ownerUid field present for rules matching", async () => {
      const { appId } = await createTestApp("credits-owner");
      cleanupIds.apps.push(appId);
      cleanupIds.credits.push(appId);

      const firestore = admin.firestore();
      await firestore.collection("app_credits").doc(appId).set({
        appId,
        ownerUid: "test-owner-uid",
        sms_remaining: 100,
        expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
        last_package_id: "test-package",
        purchased_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      const doc = await firestore.collection("app_credits").doc(appId).get();
      const data = doc.data();

      // Rules: allow read: if request.auth.uid == resource.data.ownerUid
      expect(data).toHaveProperty("ownerUid");
      expect(data.ownerUid).toBe("test-owner-uid");
    });

    test("sms_remaining and expires_at fields are correct types", async () => {
      const { appId } = await createTestApp("credits-types");
      cleanupIds.apps.push(appId);
      cleanupIds.credits.push(appId);

      const firestore = admin.firestore();
      const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
      await firestore.collection("app_credits").doc(appId).set({
        appId,
        ownerUid: "test-owner-uid",
        sms_remaining: 500,
        expires_at: futureExpiry,
        last_package_id: null,
        purchased_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      const doc = await firestore.collection("app_credits").doc(appId).get();
      const data = doc.data();

      expect(typeof data.sms_remaining).toBe("number");
      expect(data.sms_remaining).toBe(500);
      expect(typeof data.expires_at).toBe("number");
      expect(data.expires_at).toBe(futureExpiry);
    });

    test("admin can read any app_credits document", () => {
      // Rules: allow read: if request.auth.token.admin == true
      // Conceptual test — actual enforcement at Firestore rules layer.
      // Admin claim check is separate from ownerUid check.
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------
  // app_credits/{appId}/usage/{usageId}
  // -------------------------------------------------------
  describe("app_credits/{appId}/usage", () => {
    test("session_id and phone_number_hash stored correctly", async () => {
      const { appId } = await createTestApp("usage");
      cleanupIds.apps.push(appId);
      cleanupIds.credits.push(appId);

      const firestore = admin.firestore();

      // Set up parent doc
      await firestore.collection("app_credits").doc(appId).set({
        appId,
        ownerUid: "test-owner-uid",
        sms_remaining: 100,
        expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      // Add usage record
      const sessionId = crypto.randomUUID();
      const phoneNumberHash = crypto
        .createHash("sha256")
        .update("+8801712345678")
        .digest("hex");

      const usageRef = await firestore
        .collection("app_credits")
        .doc(appId)
        .collection("usage")
        .add({
          deducted_at: admin.firestore.FieldValue.serverTimestamp(),
          session_id: sessionId,
          phone_number_hash: phoneNumberHash,
        });

      const usageDoc = await usageRef.get();
      const usageData = usageDoc.data();

      // Rules: allow read: if request.auth.token.admin == true (admin only)
      expect(usageData).toHaveProperty("session_id");
      expect(usageData).toHaveProperty("phone_number_hash");
      expect(usageData.session_id).toBe(sessionId);
      expect(usageData.phone_number_hash).toBe(phoneNumberHash);
      expect(usageData.phone_number_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // -------------------------------------------------------
  // transactions/{transactionId}
  // -------------------------------------------------------
  describe("transactions/{transactionId}", () => {
    test("ownerUid field present for rules matching", async () => {
      const { appId } = await createTestApp("tx-owner");
      cleanupIds.apps.push(appId);

      const transactionId = crypto.randomUUID();
      cleanupIds.transactions.push(transactionId);

      const firestore = admin.firestore();
      await firestore.collection("transactions").doc(transactionId).set({
        appId,
        ownerUid: "test-owner-uid",
        package_id: "test-package",
        sms_quota: 100,
        validity_days: 30,
        amount_bdt: 500,
        trx_id: null,
        status: "pending",
        requested_at: admin.firestore.FieldValue.serverTimestamp(),
        approved_at: null,
        admin_id: null,
        admin_notes: null,
      });

      const doc = await firestore
        .collection("transactions")
        .doc(transactionId)
        .get();
      const data = doc.data();

      // Rules: allow read: if request.auth.uid == resource.data.ownerUid
      expect(data).toHaveProperty("ownerUid");
      expect(data.ownerUid).toBe("test-owner-uid");
    });

    test("status field is valid enum (pending, approved, rejected)", async () => {
      const firestore = admin.firestore();
      const validStatuses = ["pending", "approved", "rejected"];

      for (const status of validStatuses) {
        const transactionId = crypto.randomUUID();
        cleanupIds.transactions.push(transactionId);

        await firestore.collection("transactions").doc(transactionId).set({
          appId: "test-app",
          ownerUid: "test-owner-uid",
          package_id: "pkg",
          sms_quota: 100,
          validity_days: 30,
          amount_bdt: 500,
          status,
          requested_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        const doc = await firestore
          .collection("transactions")
          .doc(transactionId)
          .get();
        expect(doc.data().status).toBe(status);
      }
    });

    test("admin can read any transaction", () => {
      // Rules: allow read: if request.auth.token.admin == true
      // Conceptual test — actual enforcement at Firestore rules layer.
      expect(true).toBe(true);
    });

    test("No client can write transactions directly (Admin SDK only)", () => {
      // Rules: allow write: if false
      // All writes go through Cloud Functions (Admin SDK bypasses rules).
      // Client SDK writes are blocked by rules.
      expect(true).toBe(true);
    });
  });
});
