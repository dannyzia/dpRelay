const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const db = admin.firestore();

/**
 * onCall /requestCredit
 *
 * Called by an authenticated dashboard user to initiate a credit purchase.
 * Verifies the user owns the selected app, then creates a pending transaction.
 *
 * Request data:
 * {
 *   "appId": "uuid-v4",
 *   "packageId": "firestore-document-id"
 * }
 *
 * Response data:
 * {
 *   "transactionId": "uuid-v4",
 *   "bkashNumber": "+8801XXXXXXXXX",
 *   "amount": 500
 * }
 */
exports.requestCredit = onCall(
  {
    region: "asia-southeast1",
    secrets: ["BKASH_PERSONAL_NUMBER"],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const { appId, packageId } = request.data;

    if (!appId || !packageId) {
      throw new HttpsError(
        "invalid-argument",
        "appId and packageId are required",
      );
    }

    const uid = request.auth.uid;

    // Guard: fail fast if the secret is not configured rather than
    // returning a placeholder that would confuse the client.
    const bkashNumber = process.env.BKASH_PERSONAL_NUMBER;
    if (!bkashNumber) {
      logger.error(
        "[requestCredit] BKASH_PERSONAL_NUMBER secret is not configured.",
      );
      throw new HttpsError(
        "internal",
        "Payment configuration error. Please contact support.",
      );
    }

    // Verify the app exists and belongs to this user.
    const rtdb = admin.database();
    const appSnapshot = await rtdb
      .ref(`registered_apps/${appId}`)
      .once("value");

    if (!appSnapshot.exists()) {
      throw new HttpsError("not-found", "App not found");
    }

    const appData = appSnapshot.val();

    if (appData.ownerUid !== uid) {
      throw new HttpsError("permission-denied", "You do not own this app");
    }

    if (appData.active !== true) {
      throw new HttpsError("permission-denied", "App has been revoked");
    }

    // Fetch and validate the package.
    const packageDoc = await db.collection("packages").doc(packageId).get();

    if (!packageDoc.exists) {
      throw new HttpsError("not-found", "Package not found");
    }

    const packageData = packageDoc.data();

    if (packageData.is_active !== true) {
      throw new HttpsError("not-found", "Package is not active");
    }

    const transactionId = crypto.randomUUID();

    await db.collection("transactions").doc(transactionId).set({
      appId,
      ownerUid: uid,
      package_id: packageId,
      sms_quota: packageData.sms_quota,
      validity_days: packageData.validity_days,
      amount_bdt: packageData.price_bdt,
      trx_id: null,
      status: "pending",
      requested_at: admin.firestore.FieldValue.serverTimestamp(),
      approved_at: null,
      admin_id: null,
      admin_notes: null,
    });

    logger.info(
      `[requestCredit] Created transaction ${transactionId} for app ${appId}`,
    );

    return {
      transactionId,
      bkashNumber,
      bkashNote: "Send Money",
      amount: packageData.price_bdt,
    };
  },
);

module.exports = { requestCredit: exports.requestCredit };
