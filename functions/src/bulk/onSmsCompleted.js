const { onValueDeleted } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const firestore = admin.firestore();
const rtdb = admin.database();

// How long to block a phone number from receiving another SMS after a
// confirmed delivery.  Two minutes gives the user time to read the code
// without blocking legitimate re-requests for too long.
const POST_CONFIRM_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

/**
 * RTDB trigger for deleted /pending_sms entries.
 * If the deleted entry belonged to a bulk campaign and was deleted cleanly,
 * increment bulk progress and mark the recipient as sent.
 */
exports.onSmsCompleted = onValueDeleted(
  {
    region: "asia-southeast1",
    ref: "/pending_sms/{sessionId}",
  },
  async (event) => {
    const deletedData = event.data?.val();
    if (!deletedData) {
      return null;
    }

    const { batchId, jobId, error } = deletedData;

    if (!batchId) {
      // ── OTP confirmed delivery ─────────────────────────────────────────────
      // The Android app ONLY deletes a /pending_sms node on SMS send success
      // (on failure it writes an error sub-node instead).  So reaching here
      // means the OTP SMS was genuinely delivered.
      //
      // 1. Stamp otp_requests/{sessionId} with sent_at so otpStatus can detect
      //    confirmed delivery and refuse any further resend attempts.
      // 2. Extend the per-phone cooldown in RTDB to POST_CONFIRM_COOLDOWN_MS
      //    so neither sendOtp nor processBulkQueue can target this number again
      //    within that window.
      const sessionId = event.params.sessionId;
      const phoneNumber = deletedData.to;

      if (phoneNumber) {
        // (a) Write sent_at to otp_requests so otpStatus can confirm delivery.
        const otpRef = rtdb.ref(`otp_requests/${sessionId}`);
        const otpSnap = await otpRef.once("value");
        if (otpSnap.exists()) {
          await otpRef.update({
            sent_at: admin.database.ServerValue.TIMESTAMP,
          });
          logger.info(
            `[onSmsCompleted] OTP confirmed sent — sessionId=${sessionId} to=${phoneNumber}`,
          );
        }

        // (b) Extend the per-phone cooldown to 2 minutes from confirmed delivery.
        const phoneCooldownHash = crypto
          .createHash("sha256")
          .update(phoneNumber)
          .digest("hex")
          .substring(0, 32);
        await rtdb.ref(`otp_cooldown/${phoneCooldownHash}`).set({
          expiresAt: Date.now() + POST_CONFIRM_COOLDOWN_MS,
          appId: deletedData.appId || null,
          confirmedAt: Date.now(),
          source: "otp_confirmed",
        });
      }

      return null;
    }

    if (error != null) {
      // This deletion appears to be cleanup for an errored bulk entry.
      return null;
    }

    const bulkProgressRef = rtdb.ref(`bulk_progress/${batchId}`);

    try {
      await bulkProgressRef.transaction((currentData) => {
        if (currentData === null) {
          return currentData;
        }

        return {
          ...currentData,
          sentCount: (currentData.sentCount || 0) + 1,
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        };
      });
    } catch (errorUpdate) {
      logger.error(
        `[onSmsCompleted] Failed to update bulk_progress for campaign=${batchId}`,
        errorUpdate,
      );
    }

    if (jobId) {
      try {
        const recipientRef = firestore.doc(
          `bulk_campaigns/${batchId}/recipients/${jobId}`,
        );
        const recipientDoc = await recipientRef.get();

        if (recipientDoc.exists) {
          const recipientData = recipientDoc.data();
          await recipientRef.update({
            status: "sent",
            attempts: (recipientData.attempts || 0) + 1,
            lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          logger.warn(
            `[onSmsCompleted] Recipient doc not found for jobId=${jobId} campaign=${batchId}`,
          );
        }
      } catch (recipientError) {
        logger.error(
          `[onSmsCompleted] Failed to update recipient ${jobId} for campaign=${batchId}`,
          recipientError,
        );
      }
    }

    logger.info(
      `[onSmsCompleted] Bulk SMS completed for campaign=${batchId}, jobId=${jobId}`,
    );

    return null;
  },
);

module.exports = { onSmsCompleted: exports.onSmsCompleted };
