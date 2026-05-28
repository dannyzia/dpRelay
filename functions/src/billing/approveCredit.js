const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const db = admin.firestore();

/**
 * Approves or rejects a credit purchase transaction.
 * Admin-only callable function with idempotency.
 *
 * Callable from: Transaction Approval Queue (admin only)
 *
 * Request data:
 * {
 *   "transactionId": "transaction-id",
 *   "approve": true/false,
 *   "rejectReason": "optional reason string"
 * }
 *
 * Response (approve):
 * {
 *   "success": true,
 *   "new_balance": 1500
 * }
 *
 * Response (reject):
 * {
 *   "success": true
 * }
 *
 * Response (already resolved):
 * {
 *   "error": "already_resolved",
 *   "status": "approved|rejected"
 * }
 */
exports.approveCredit = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    // Verify the caller has admin claim.
    // Callable functions already expose decoded token claims in request.auth.
    const decodedToken =
      request.auth && typeof request.auth.token === "object"
        ? { ...request.auth.token, uid: request.auth.uid }
        : null;

    if (!decodedToken || !decodedToken.admin) {
      throw new HttpsError("permission-denied", "Admin claim required");
    }

    const { transactionId, approve, rejectReason } = request.data;

    if (
      !transactionId ||
      typeof transactionId !== "string" ||
      transactionId.trim().length === 0
    ) {
      throw new HttpsError(
        "invalid-argument",
        "transactionId is required and must be a non-empty string",
      );
    }

    if (typeof approve !== "boolean") {
      throw new HttpsError("invalid-argument", "approve must be a boolean");
    }

    try {
      const transactionDoc = await db
        .collection("transactions")
        .doc(transactionId)
        .get();

      if (!transactionDoc.exists) {
        throw new HttpsError("not-found", "Transaction not found");
      }

      const transactionData = transactionDoc.data();

      if (transactionData.status !== "pending") {
        throw new HttpsError(
          "already-exists",
          `Transaction already resolved with status: ${transactionData.status}`,
        );
      }

      const rtdb = admin.database();
      const appSnapshot = await rtdb
        .ref(`registered_apps/${transactionData.appId}`)
        .once("value");

      if (!appSnapshot.exists()) {
        throw new HttpsError("not-found", "App not found");
      }

      const appData = appSnapshot.val();
      const ownerUid = appData.ownerUid;

      if (approve) {
        await db.runTransaction(async (t) => {
          const packageRef = db
            .collection("packages")
            .doc(transactionData.package_id);
          const packageDoc = await t.get(packageRef);
          const packageType = packageDoc.exists
            ? packageDoc.data().type || "otp"
            : "otp";

          const creditsRef = db
            .collection("app_credits")
            .doc(transactionData.appId);
          const creditsDoc = await t.get(creditsRef);

          let currentSmsRemaining = 0;
          let currentExpiresAt = null;
          let currentBulkRemaining = 0;
          let currentBulkExpiresAt = null;

          if (creditsDoc.exists) {
            const creditsData = creditsDoc.data();
            currentSmsRemaining = creditsData.sms_remaining || 0;
            currentBulkRemaining = creditsData.bulk_sms_remaining || 0;

            const storedExpires = creditsData.expires_at;
            if (storedExpires) {
              currentExpiresAt =
                typeof storedExpires === "object" &&
                storedExpires._seconds !== undefined
                  ? storedExpires._seconds * 1000 +
                    (storedExpires._nanoseconds || 0) / 1000000
                  : Number(storedExpires);
            }

            const storedBulkExpires = creditsData.bulk_expires_at;
            if (storedBulkExpires) {
              currentBulkExpiresAt =
                typeof storedBulkExpires === "object" &&
                storedBulkExpires._seconds !== undefined
                  ? storedBulkExpires._seconds * 1000 +
                    (storedBulkExpires._nanoseconds || 0) / 1000000
                  : Number(storedBulkExpires);
            }
          }

          const now = Date.now();
          const validityMs =
            transactionData.validity_days * 24 * 60 * 60 * 1000;
          const newExpiresAt = Math.max(
            currentExpiresAt || 0,
            now + validityMs,
          );
          const newBulkExpiresAt = Math.max(
            currentBulkExpiresAt || 0,
            now + validityMs,
          );

          const updateData = {
            appId: transactionData.appId,
            ownerUid: ownerUid || null,
            last_package_id: transactionId,
            purchased_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          };

          if (packageType === "otp" || packageType === "both") {
            updateData.sms_remaining =
              currentSmsRemaining + transactionData.sms_quota;
            updateData.expires_at = newExpiresAt;
          }

          if (packageType === "bulk" || packageType === "both") {
            updateData.bulk_sms_remaining =
              currentBulkRemaining + transactionData.sms_quota;
            updateData.bulk_expires_at = newBulkExpiresAt;
            updateData.bulk_last_package_id = transactionId;
            updateData.bulk_purchased_at =
              admin.firestore.FieldValue.serverTimestamp();
          }

          t.set(creditsRef, updateData, { merge: true });

          return packageType === "bulk"
            ? currentBulkRemaining + transactionData.sms_quota
            : currentSmsRemaining + transactionData.sms_quota;
        });

        await db.collection("transactions").doc(transactionId).update({
          status: "approved",
          approved_at: admin.firestore.FieldValue.serverTimestamp(),
          admin_id: decodedToken.uid,
        });

        const finalCreditsDoc = await db
          .collection("app_credits")
          .doc(transactionData.appId)
          .get();
        const finalCreditsData = finalCreditsDoc.exists
          ? finalCreditsDoc.data()
          : {};

        logger.info(
          `[approveCredit] Approved transaction ${transactionId} for app ${transactionData.appId}. OTP balance=${finalCreditsData.sms_remaining || 0} bulk balance=${finalCreditsData.bulk_sms_remaining || 0}`,
        );

        return {
          success: true,
          new_balance: finalCreditsData.sms_remaining || 0,
          new_bulk_balance: finalCreditsData.bulk_sms_remaining || 0,
        };
      } else {
        await db
          .collection("transactions")
          .doc(transactionId)
          .update({
            status: "rejected",
            admin_notes: rejectReason || null,
            admin_id: decodedToken.uid,
          });

        logger.info(
          `[approveCredit] Rejected transaction ${transactionId} for app ${transactionData.appId}`,
        );

        return {
          success: true,
        };
      }
    } catch (error) {
      logger.error("[approveCredit] Error:", error);

      // Re-throw HttpsError instances that were thrown intentionally (e.g. not-found, already-exists)
      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError("internal", "Failed to approve/reject transaction");
    }
  },
);

module.exports = { approveCredit: exports.approveCredit };
