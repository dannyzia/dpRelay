const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const firestore = admin.firestore();
const rtdb = admin.database();

const BULK_SMS_RATE_PER_MINUTE =
  Number(process.env.BULK_SMS_RATE_PER_MINUTE) || 30;
const BULK_MAX_PENDING_QUEUE =
  Number(process.env.BULK_MAX_PENDING_QUEUE) || 100;
const BULK_RETRY_MAX_ATTEMPTS =
  Number(process.env.BULK_RETRY_MAX_ATTEMPTS) || 3;
const BULK_STALE_ENTRY_TIMEOUT_MS =
  Number(process.env.BULK_STALE_ENTRY_TIMEOUT_MS) || 300000;

function isBulkPendingEntry(entry) {
  return entry && entry.batchId;
}

/**
 * Returns true if the given E.164 phone number is currently under a
 * delivery cooldown (i.e., a recent OTP or bulk SMS was just confirmed sent).
 * Reads the same otp_cooldown/{hash} node used by sendOtp.
 * @param {string} phoneNumber
 * @returns {Promise<boolean>}
 */
async function isPhoneOnCooldown(phoneNumber) {
  const hash = crypto
    .createHash("sha256")
    .update(phoneNumber)
    .digest("hex")
    .substring(0, 32);
  const snap = await rtdb.ref(`otp_cooldown/${hash}`).once("value");
  if (!snap.exists()) return false;
  const data = snap.val();
  return data && data.expiresAt > Date.now();
}

exports.processBulkQueue = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "asia-southeast1",
    timeZone: "Asia/Dhaka",
  },
  async () => {
    try {
      const now = Date.now();
      const pendingSnapshot = await rtdb.ref("pending_sms").once("value");
      const bulkEntries = [];

      if (pendingSnapshot.exists()) {
        pendingSnapshot.forEach((childSnapshot) => {
          const entry = childSnapshot.val();
          if (isBulkPendingEntry(entry)) {
            bulkEntries.push({ id: childSnapshot.key, ...entry });
          }
        });
      }

      let retriesHandled = 0;
      for (const entry of bulkEntries) {
        if (!entry.error) {
          continue;
        }

        const createdAt = Number(entry.createdAt || 0);
        if (createdAt + BULK_STALE_ENTRY_TIMEOUT_MS > now) {
          continue;
        }

        const batchId = entry.batchId;
        const recipientJobId = entry.jobId;
        const retryCount = Number(entry.retryCount || 0);
        const errorData = entry.error || {};
        const errorCode = errorData.errorCode || "UNKNOWN";
        const errorMessage = errorData.error || "SMS send error";

        await rtdb.ref(`pending_sms/${entry.id}`).remove();

        if (retryCount < BULK_RETRY_MAX_ATTEMPTS) {
          retriesHandled += 1;
          if (recipientJobId) {
            const recipientRef = firestore.doc(
              `bulk_campaigns/${batchId}/recipients/${recipientJobId}`,
            );
            await recipientRef.update({
              status: "retrying",
              lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } else {
          const progressRef = rtdb.ref(`bulk_progress/${batchId}`);
          await progressRef.transaction((current) => {
            if (current === null) {
              return current;
            }
            return {
              ...current,
              failedCount: (current.failedCount || 0) + 1,
              updatedAt: admin.database.ServerValue.TIMESTAMP,
            };
          });

          if (recipientJobId) {
            const recipientRef = firestore.doc(
              `bulk_campaigns/${batchId}/recipients/${recipientJobId}`,
            );
            await recipientRef.update({
              status: "failed",
              attempts: retryCount,
              lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
              errorCode,
              errorMessage,
            });
          }
        }
      }

      const updatedPendingSnapshot = await rtdb
        .ref("pending_sms")
        .once("value");
      let currentBulkPending = 0;
      if (updatedPendingSnapshot.exists()) {
        updatedPendingSnapshot.forEach((childSnapshot) => {
          const entry = childSnapshot.val();
          if (isBulkPendingEntry(entry)) {
            currentBulkPending += 1;
          }
        });
      }

      if (currentBulkPending >= BULK_MAX_PENDING_QUEUE) {
        logger.info(
          `[processBulkQueue] Bulk pending queue at limit (${currentBulkPending}/${BULK_MAX_PENDING_QUEUE}), skipping enqueue phase`,
        );
        return;
      }

      const activeCampaignSnapshot = await firestore
        .collection("bulk_campaigns")
        .where("status", "in", ["queued", "sending"])
        .orderBy("createdAt", "asc")
        .get();

      if (activeCampaignSnapshot.empty) {
        logger.info("[processBulkQueue] No active bulk campaigns to process");
        return;
      }

      const activeCampaigns = [];
      activeCampaignSnapshot.forEach((doc) => {
        activeCampaigns.push({ id: doc.id, data: doc.data() });
      });

      const activeCampaignCount = activeCampaigns.length;
      const retryBudget = Math.max(
        0,
        BULK_SMS_RATE_PER_MINUTE - retriesHandled,
      );
      const perCampaignBudget = Math.max(
        1,
        Math.floor(retryBudget / activeCampaignCount) || 1,
      );

      let totalCreated = 0;
      let campaignsProcessed = 0;

      for (const campaign of activeCampaigns) {
        if (currentBulkPending >= BULK_MAX_PENDING_QUEUE) {
          break;
        }

        const campaignId = campaign.id;
        const campaignData = campaign.data;
        const campaignRef = firestore
          .collection("bulk_campaigns")
          .doc(campaignId);

        if (campaignData.status === "queued") {
          await campaignRef.update({
            status: "sending",
            startedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          await rtdb.ref(`bulk_progress/${campaignId}`).update({
            status: "sending",
            updatedAt: admin.database.ServerValue.TIMESTAMP,
          });
        }

        const remainingBudget = Math.max(
          0,
          BULK_SMS_RATE_PER_MINUTE - currentBulkPending,
        );
        const campaignBudget = Math.max(
          1,
          Math.min(perCampaignBudget, remainingBudget),
        );

        const recipientsSnapshot = await campaignRef
          .collection("recipients")
          .where("status", "in", ["pending", "retrying"])
          .orderBy("index", "asc")
          .limit(campaignBudget)
          .get();

        if (recipientsSnapshot.empty) {
          continue;
        }

        const recipientUpdates = firestore.batch();
        const pendingUpdates = {};
        let batchSize = 0;
        let highestIndex = campaignData.nextRecipientIndex || 0;

        // Check per-phone cooldowns in parallel before building the batch.
        // Phones under a cooldown (recent OTP or bulk delivery) are skipped —
        // they will be retried in the next processBulkQueue run (1 min later).
        const cooldownChecks = await Promise.all(
          recipientsSnapshot.docs.map((doc) =>
            isPhoneOnCooldown(doc.data().phone).then((blocked) => ({
              id: doc.id,
              blocked,
            })),
          ),
        );
        const blockedIds = new Set(
          cooldownChecks.filter((c) => c.blocked).map((c) => c.id),
        );
        if (blockedIds.size > 0) {
          logger.info(
            `[processBulkQueue] campaign=${campaignId}: skipped ${blockedIds.size} phone(s) under cooldown`,
          );
        }

        recipientsSnapshot.forEach((recipientDoc) => {
          const recipient = recipientDoc.data();
          const recipientId = recipientDoc.id;

          // Skip this phone if it is under a post-delivery cooldown.
          if (blockedIds.has(recipientId)) return;

          const pendingId = `${campaignId}_${recipientId}`;
          const createdAtValue = admin.database.ServerValue.TIMESTAMP;

          pendingUpdates[`pending_sms/${pendingId}`] = {
            appId: campaignData.appId,
            to: recipient.phone,
            message: campaignData.message,
            status: "pending",
            createdAt: createdAtValue,
            batchId: campaignId,
            jobId: recipientId,
            retryCount: recipient.attempts || 0,
          };

          recipientUpdates.update(recipientDoc.ref, {
            status: "queued",
          });

          batchSize += 1;
          currentBulkPending += 1;
          highestIndex = Math.max(highestIndex, recipient.index + 1);
        });

        if (batchSize === 0) {
          continue;
        }

        await rtdb.ref().update(pendingUpdates);
        await recipientUpdates.commit();

        await campaignRef.update({
          queuedCount: admin.firestore.FieldValue.increment(batchSize),
          nextRecipientIndex: highestIndex,
        });

        totalCreated += batchSize;
        campaignsProcessed += 1;

        if (currentBulkPending >= BULK_MAX_PENDING_QUEUE) {
          break;
        }
      }

      logger.info(
        `[processBulkQueue] created=${totalCreated} entries, retriesHandled=${retriesHandled}, campaignsProcessed=${campaignsProcessed}`,
      );
    } catch (error) {
      logger.error("[processBulkQueue] Error:", error);
    }
  },
);

module.exports = { processBulkQueue: exports.processBulkQueue };
