const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const db = admin.firestore();

/**
 * onCall /submitTrxId
 *
 * Attaches a bKash TrxID to a pending transaction created by the authenticated
 * user. Ownership is verified via the transaction's ownerUid field.
 * Checks for duplicate TrxIDs to prevent double-crediting.
 *
 * Request data:
 * {
 *   "transactionId": "uuid-v4",
 *   "trxId": "TRX123ABC"
 * }
 *
 * Response data:
 * {
 *   "message": "TrxID submitted. Awaiting admin approval."
 * }
 */
exports.submitTrxId = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const { transactionId, trxId } = request.data;

    if (!transactionId || !trxId) {
      throw new HttpsError(
        "invalid-argument",
        "transactionId and trxId are required",
      );
    }

    if (typeof trxId !== "string" || trxId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "trxId must be a non-empty string",
      );
    }

    const uid = request.auth.uid;

    const transactionDoc = await db
      .collection("transactions")
      .doc(transactionId)
      .get();

    if (!transactionDoc.exists) {
      throw new HttpsError("not-found", "Transaction not found");
    }

    const transactionData = transactionDoc.data();

    // Verify the transaction belongs to this user.
    if (transactionData.ownerUid !== uid) {
      throw new HttpsError(
        "permission-denied",
        "Transaction does not belong to you",
      );
    }

    if (transactionData.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        `Transaction has already been ${transactionData.status}`,
      );
    }

    // Guard against reuse of an already-approved TrxID.
    const duplicateSnapshot = await db
      .collection("transactions")
      .where("trx_id", "==", trxId.trim())
      .limit(1)
      .get();

    if (!duplicateSnapshot.empty) {
      const existingTrx = duplicateSnapshot.docs[0].data();
      if (existingTrx.status === "approved") {
        throw new HttpsError(
          "already-exists",
          "This TrxID has already been used and approved",
        );
      }
    }

    await db.collection("transactions").doc(transactionId).update({
      trx_id: trxId.trim(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(
      `[submitTrxId] Submitted TrxID ${trxId} for transaction ${transactionId}`,
    );

    return { message: "TrxID submitted. Awaiting admin approval." };
  },
);

module.exports = { submitTrxId: exports.submitTrxId };
