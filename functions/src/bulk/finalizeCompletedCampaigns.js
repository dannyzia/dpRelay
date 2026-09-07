const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { sendBulkWebhook } = require("./sendBulkWebhook");

const firestore = admin.firestore();
const rtdb = admin.database();

exports.finalizeCompletedCampaigns = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "asia-southeast1",
    timeZone: "Asia/Dhaka",
  },
  async () => {
    try {
      const snapshot = await firestore
        .collection("bulk_campaigns")
        .where("status", "==", "sending")
        .get();

      if (snapshot.empty) {
        logger.info(
          "[finalizeCompletedCampaigns] No sending bulk campaigns found",
        );
        return;
      }

      for (const doc of snapshot.docs) {
        const campaignId = doc.id;
        const campaignData = doc.data();
        const progressSnapshot = await rtdb
          .ref(`bulk_progress/${campaignId}`)
          .once("value");
        const progress = progressSnapshot.exists()
          ? progressSnapshot.val()
          : null;
        const sentCount = progress?.sentCount || 0;
        const failedCount = progress?.failedCount || 0;
        const totalCount = campaignData.totalRecipients || 0;
        const nextRecipientIndex = Number(campaignData.nextRecipientIndex || 0);

        const pendingRecipients = await firestore
          .collection(`bulk_campaigns/${campaignId}/recipients`)
          .where("status", "in", ["pending", "queued", "retrying"])
          .get();

        const pendingCount = pendingRecipients.size;

        const isFullyQueued = nextRecipientIndex >= totalCount;
        const isAllProcessed = pendingCount === 0 && isFullyQueued;

        if (isAllProcessed) {
          const completedAt = admin.firestore.FieldValue.serverTimestamp();

          await firestore.collection("bulk_campaigns").doc(campaignId).update({
            status: "completed",
            sentCount,
            failedCount,
            completedAt,
          });

          if (progressSnapshot.exists()) {
            await rtdb.ref(`bulk_progress/${campaignId}`).remove();
          }

          const results = {
            sentCount,
            failedCount,
            totalRecipients: totalCount,
            completedAt: Date.now(),
          };

          try {
            await sendBulkWebhook(campaignId, campaignData.appId, results);
          } catch (webhookError) {
            logger.error(
              `[finalizeCompletedCampaigns] Bulk webhook failed for campaign=${campaignId}`,
              webhookError,
            );
          }

          logger.info(
            `[finalizeCompletedCampaigns] Campaign completed campaignId=${campaignId} sent=${sentCount} failed=${failedCount}`,
          );
        } else {
          await firestore
            .collection("bulk_campaigns")
            .doc(campaignId)
            .update({
              sentCount,
              failedCount,
              queuedCount: campaignData.queuedCount || 0,
            });

          logger.info(
            `[finalizeCompletedCampaigns] Synced campaign=${campaignId} sent=${sentCount} failed=${failedCount} queuedCount=${campaignData.queuedCount || 0}`,
          );
        }
      }
    } catch (error) {
      logger.error("[finalizeCompletedCampaigns] Error:", error);
    }
  },
);

module.exports = {
  finalizeCompletedCampaigns: exports.finalizeCompletedCampaigns,
};
