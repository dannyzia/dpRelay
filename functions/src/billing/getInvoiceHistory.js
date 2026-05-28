const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const db = admin.firestore();

/**
 * Callable /getInvoiceHistory
 *
 * Aggregates billing history for a specific app (or all apps owned by the
 * caller) within an optional date range.
 *
 * Request data:
 * {
 *   "appId":     "uuid-v4"  (optional – omit to get all apps for this user)
 *   "startDate": "ISO-8601" (optional – defaults to 30 days ago)
 *   "endDate":   "ISO-8601" (optional – defaults to now)
 * }
 *
 * Response data:
 * {
 *   "purchases":      [...],   // approved credit transactions
 *   "otpUsage":       [...],   // per-OTP deduction records
 *   "bulkCampaigns":  [...],   // bulk campaign records
 *   "summary": {
 *     "totalPurchases":  number,
 *     "totalAmountBdt":  number,
 *     "totalOtpUsed":    number,
 *     "totalBulkSent":   number
 *   }
 * }
 */
exports.getInvoiceHistory = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const uid = request.auth.uid;
    const isAdmin = request.auth.token?.admin === true;
    const { appId, startDate, endDate } = request.data || {};

    // Resolve date range (default: last 30 days).
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new HttpsError(
        "invalid-argument",
        "startDate and endDate must be valid ISO-8601 date strings.",
      );
    }

    if (start > end) {
      throw new HttpsError(
        "invalid-argument",
        "startDate must be before endDate.",
      );
    }

    // Ownership check – non-admins may only query their own apps.
    if (!isAdmin && appId) {
      const rtdb = admin.database();
      const appSnap = await rtdb.ref(`registered_apps/${appId}`).once("value");
      if (!appSnap.exists() || appSnap.val().ownerUid !== uid) {
        throw new HttpsError("permission-denied", "You do not own this app.");
      }
    }

    // ── 1. Approved credit purchases ─────────────────────────────────────
    let txQuery;
    if (appId) {
      txQuery = db
        .collection("transactions")
        .where("appId", "==", appId)
        .where("status", "==", "approved")
        .where("requested_at", ">=", start)
        .where("requested_at", "<=", end)
        .orderBy("requested_at", "desc");
    } else if (isAdmin) {
      txQuery = db
        .collection("transactions")
        .where("status", "==", "approved")
        .where("requested_at", ">=", start)
        .where("requested_at", "<=", end)
        .orderBy("requested_at", "desc");
    } else {
      txQuery = db
        .collection("transactions")
        .where("ownerUid", "==", uid)
        .where("status", "==", "approved")
        .where("requested_at", ">=", start)
        .where("requested_at", "<=", end)
        .orderBy("requested_at", "desc");
    }

    const txSnap = await txQuery.limit(200).get();
    const purchases = txSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        type: "purchase",
        appId: d.appId,
        packageId: d.package_id || null,
        amount_bdt: d.amount_bdt || 0,
        sms_quota: d.sms_quota || 0,
        validity_days: d.validity_days || null,
        status: d.status,
        requested_at: d.requested_at?.toDate?.()?.toISOString() ?? null,
        approved_at: d.approved_at?.toDate?.()?.toISOString() ?? null,
      };
    });

    // ── 2. OTP usage records ──────────────────────────────────────────────
    let otpUsage = [];
    if (appId) {
      const usageSnap = await db
        .collection("app_credits")
        .doc(appId)
        .collection("usage")
        .where("deducted_at", ">=", start)
        .where("deducted_at", "<=", end)
        .orderBy("deducted_at", "desc")
        .limit(1000)
        .get();

      otpUsage = usageSnap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          type: "otp_usage",
          appId,
          session_id: d.session_id || null,
          phone_number_hash: d.phone_number_hash || null,
          deducted_at: d.deducted_at?.toDate?.()?.toISOString() ?? null,
        };
      });
    }

    // ── 3. Bulk campaign usage ────────────────────────────────────────────
    let bulkCampaignsQuery;
    if (appId) {
      bulkCampaignsQuery = db
        .collection("bulk_campaigns")
        .where("appId", "==", appId)
        .where("createdAt", ">=", start)
        .where("createdAt", "<=", end)
        .orderBy("createdAt", "desc");
    } else if (isAdmin) {
      bulkCampaignsQuery = db
        .collection("bulk_campaigns")
        .where("createdAt", ">=", start)
        .where("createdAt", "<=", end)
        .orderBy("createdAt", "desc");
    } else {
      bulkCampaignsQuery = db
        .collection("bulk_campaigns")
        .where("ownerUid", "==", uid)
        .where("createdAt", ">=", start)
        .where("createdAt", "<=", end)
        .orderBy("createdAt", "desc");
    }

    const bulkSnap = await bulkCampaignsQuery.limit(200).get();
    const bulkCampaigns = bulkSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        type: "bulk_campaign",
        appId: d.appId,
        campaignName: d.campaignName || null,
        status: d.status || null,
        totalRecipients: d.totalRecipients || 0,
        sentCount: d.sentCount || 0,
        failedCount: d.failedCount || 0,
        bulkCreditCost: d.bulkCreditCost || 0,
        createdAt: d.createdAt?.toDate?.()?.toISOString() ?? null,
        completedAt: d.completedAt?.toDate?.()?.toISOString() ?? null,
      };
    });

    // ── 4. Summary ────────────────────────────────────────────────────────
    const totalAmountBdt = purchases.reduce(
      (sum, p) => sum + (p.amount_bdt || 0),
      0,
    );
    const totalBulkSent = bulkCampaigns.reduce(
      (sum, c) => sum + (c.sentCount || 0),
      0,
    );

    logger.info(
      `[getInvoiceHistory] uid=${uid} appId=${appId || "all"} ` +
        `range=${start.toISOString()}–${end.toISOString()} ` +
        `purchases=${purchases.length} otpUsage=${otpUsage.length} bulk=${bulkCampaigns.length}`,
    );

    return {
      purchases,
      otpUsage,
      bulkCampaigns,
      summary: {
        totalPurchases: purchases.length,
        totalAmountBdt,
        totalOtpUsed: otpUsage.length,
        totalBulkSent,
      },
    };
  },
);

module.exports = { getInvoiceHistory: exports.getInvoiceHistory };
