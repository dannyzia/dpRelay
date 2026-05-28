const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const db = admin.database();
const firestore = admin.firestore();
const logger = require("firebase-functions/logger");

/**
 * Scheduled function to aggregate statistics and write to RTDB /stats.
 * Runs every 1 minute.
 *
 * Computes:
 * - Total OTP requests today
 * - Success count
 * - Failed count
 * - Pending count
 * - Success rate
 * - Queue depth (pending SMS)
 * - Rolling 7-day history
 */
exports.aggregateStats = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "asia-southeast1",
    timeZone: "Asia/Dhaka",
  },
  async (_event) => {
    try {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

      const otpSnapshot = await db.ref("otp_requests").once("value");

      let totalToday = 0;
      const successCount = 0;
      let failedCount = 0;
      let pendingCount = 0;
      const dailyHistory = {};

      if (otpSnapshot.exists()) {
        otpSnapshot.forEach((childSnapshot) => {
          const data = childSnapshot.val();
          const createdAt = data.createdAt || 0;

          if (createdAt >= oneDayAgo) {
            totalToday++;

            if (data.locked === true) {
              failedCount++;
            } else if (data.expiresAt < now) {
              failedCount++;
            } else {
              pendingCount++;
            }
          }

          if (createdAt >= sevenDaysAgo) {
            const dateKey = new Date(createdAt).toISOString().split("T")[0];
            if (!dailyHistory[dateKey]) {
              dailyHistory[dateKey] = 0;
            }
            dailyHistory[dateKey]++;
          }
        });
      }

      const pendingSmsSnapshot = await db.ref("pending_sms").once("value");
      let queueDepth = 0;

      if (pendingSmsSnapshot.exists()) {
        pendingSmsSnapshot.forEach(() => {
          queueDepth++;
        });
      }

      const bulkCampaignSnapshot = await firestore
        .collection("bulk_campaigns")
        .where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(oneDayAgo))
        .get();

      let bulkTotalToday = 0;
      let bulkSentToday = 0;
      let bulkFailedToday = 0;
      let bulkActiveCampaigns = 0;

      if (!bulkCampaignSnapshot.empty) {
        bulkCampaignSnapshot.forEach((bulkDoc) => {
          const bulkData = bulkDoc.data();
          bulkTotalToday += 1;
          bulkSentToday += Number(bulkData.sentCount || 0);
          bulkFailedToday += Number(bulkData.failedCount || 0);

          if (["queued", "sending", "paused"].includes(bulkData.status)) {
            bulkActiveCampaigns += 1;
          }
        });
      }

      const successRate =
        totalToday > 0 ? ((successCount / totalToday) * 100).toFixed(2) : 0;

      const statsData = {
        total_today: totalToday,
        success_count: successCount,
        failed_count: failedCount,
        pending_count: pendingCount,
        success_rate: parseFloat(successRate),
        queue_depth: queueDepth,
        bulk_total_today: bulkTotalToday,
        bulk_sent_today: bulkSentToday,
        bulk_failed_today: bulkFailedToday,
        bulk_active_campaigns: bulkActiveCampaigns,
        updated_at: admin.database.ServerValue.TIMESTAMP,
      };

      await db.ref("stats").set(statsData);

      if (Object.keys(dailyHistory).length > 0) {
        const historyUpdates = {};
        for (const [date, count] of Object.entries(dailyHistory)) {
          historyUpdates[date] = { count };
        }
        await db.ref("stats/history").set(historyUpdates);
      }

      logger.info("[aggregateStats] Stats updated successfully");
    } catch (error) {
      logger.error("[aggregateStats] Error:", error);
    }
  },
);

module.exports = { aggregateStats: exports.aggregateStats };
