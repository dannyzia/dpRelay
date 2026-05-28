const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const {
  validateE164,
  validateBulkMessage,
  deduplicatePhones,
  checkDailyAppQuota,
} = require("./bulkHelpers");

const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;
const BULK_SMS_PER_CAMPAIGN_LIMIT =
  Number(process.env.BULK_SMS_PER_CAMPAIGN_LIMIT) || 10000;

const firestore = admin.firestore();
const rtdb = admin.database();

/**
 * Constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/**
 * Validates appId + appSecret against RTDB registered_apps.
 * @param {string} appId
 * @param {string} appSecret
 * @returns {Promise<{valid: boolean, error?: string, appData?: object}>}
 */
async function validateAppCredentials(appId, appSecret) {
  const appSnapshot = await rtdb
    .ref(`registered_apps/${appId}`)
    .once("value");

  if (!appSnapshot.exists()) {
    return { valid: false, error: "app_not_found" };
  }

  const appData = appSnapshot.val();

  if (appData.active !== true) {
    return { valid: false, error: "app_revoked" };
  }

  const expectedHash = crypto
    .createHmac("sha256", APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  if (!timingSafeEqual(expectedHash, appData.apiKeyHash)) {
    return { valid: false, error: "invalid_credentials" };
  }

  return { valid: true, appData };
}

/**
 * Converts a Firestore timestamp-like value to milliseconds.
 * @param {*} value
 * @returns {number|null}
 */
function timestampToMillis(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object" && value._seconds !== undefined) {
    return (
      value._seconds * 1000 + (value._nanoseconds || 0) / 1000000
    );
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * POST /sendBulkSms
 *
 * Creates a bulk SMS campaign. Authenticates via appId + appSecret
 * (same pattern as /sendOtp). No Firebase Auth required.
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "appSecret": "base64-secret",
 *   "campaignName": "Campaign name (max 100 chars)",
 *   "message": "SMS body text",
 *   "phones": ["+8801712345678", "+8801798765432"]
 * }
 *
 * Success (200):
 * {
 *   "campaignId": "uuid-v4",
 *   "totalRecipients": 150,
 *   "creditsReserved": 150,
 *   "duplicateCount": 3,
 *   "charset": "gsm",
 *   "status": "queued"
 * }
 *
 * Errors: 400, 402, 403, 404, 429, 500
 */
exports.sendBulkSms = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const setHeaders = () => {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader(
        "Server-Timing",
        `total;dur=${Date.now() - startTime}`,
      );
    };

    const {
      appId,
      appSecret,
      campaignName,
      message,
      phones,
    } = req.body;

    // ── 1. Input validation ─────────────────────────────────────────
    if (
      !appId ||
      !appSecret ||
      !campaignName ||
      !message ||
      !Array.isArray(phones)
    ) {
      setHeaders();
      return res.status(400).json({
        error: "bad_request",
        message:
          "appId, appSecret, campaignName, message, and phones[] are required",
      });
    }

    if (
      typeof campaignName !== "string" ||
      campaignName.trim().length === 0 ||
      campaignName.length > 100
    ) {
      setHeaders();
      return res.status(400).json({
        error: "bad_request",
        message:
          "campaignName must be a non-empty string (max 100 chars)",
      });
    }

    if (
      phones.length === 0 ||
      phones.length > BULK_SMS_PER_CAMPAIGN_LIMIT
    ) {
      setHeaders();
      return res.status(400).json({
        error: "bad_request",
        message: `phones must contain 1–${BULK_SMS_PER_CAMPAIGN_LIMIT} entries`,
      });
    }

    // ── 2. Authenticate ─────────────────────────────────────────────
    const validation = await validateAppCredentials(appId, appSecret);

    if (!validation.valid) {
      setHeaders();
      const status =
        validation.error === "app_revoked" ||
        validation.error === "invalid_credentials"
          ? 403
          : 404;
      const messages = {
        app_revoked: "App has been revoked",
        app_not_found: "App not found or invalid appId",
        invalid_credentials: "Invalid appSecret",
      };
      return res.status(status).json({
        error: validation.error,
        message: messages[validation.error] || "Authentication failed",
      });
    }

    const appData = validation.appData;

    // ── 3. Feature flag check ───────────────────────────────────────
    const bulkFlagSnapshot = await rtdb
      .ref("config/bulk_enabled")
      .once("value");
    const bulkEnabled = bulkFlagSnapshot.exists()
      ? bulkFlagSnapshot.val() === true
      : false;

    if (!bulkEnabled) {
      setHeaders();
      return res.status(403).json({
        error: "bulk_not_enabled",
        message:
          "Bulk SMS is not enabled for this project. Contact support.",
      });
    }

    // ── 4. Validate message ─────────────────────────────────────────
    const messageValidation = validateBulkMessage(message);

    if (!messageValidation.valid) {
      setHeaders();
      return res.status(400).json({
        error: "bad_request",
        message: messageValidation.error,
      });
    }

    // ── 5. Validate phone numbers ───────────────────────────────────
    const invalidPhones = phones.filter((p) => !validateE164(p));
    if (invalidPhones.length > 0) {
      setHeaders();
      return res.status(400).json({
        error: "bad_request",
        message: `Invalid E.164 numbers: ${invalidPhones
          .slice(0, 5)
          .join(", ")}${invalidPhones.length > 5 ? " ..." : ""}`,
        invalidCount: invalidPhones.length,
      });
    }

    // ── 6. Deduplicate ──────────────────────────────────────────────
    const { unique, duplicateCount } = deduplicatePhones(phones);
    const uniqueCount = unique.length;

    // ── 7. Daily quota check ────────────────────────────────────────
    const now = Date.now();
    const todayStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );

    const dailyRemaining = await checkDailyAppQuota(
      appId,
      firestore,
      todayStart,
    );
    if (dailyRemaining < uniqueCount) {
      setHeaders();
      return res.status(429).json({
        error: "daily_quota_exceeded",
        message: `Daily bulk quota exceeded. Remaining: ${dailyRemaining}, Requested: ${uniqueCount}`,
      });
    }

    // ── 8. Reserve credits (transaction) ────────────────────────────
    const creditsDocRef = firestore
      .collection("app_credits")
      .doc(appId);
    const campaignId = crypto.randomUUID();

    try {
      await firestore.runTransaction(async (t) => {
        const creditsDoc = await t.get(creditsDocRef);
        const creditsData = creditsDoc.exists
          ? creditsDoc.data()
          : {};
        const currentBulkRemaining = Number(
          creditsData.bulk_sms_remaining || 0,
        );
        const bulkExpiresAt = timestampToMillis(
          creditsData.bulk_expires_at,
        );

        if (bulkExpiresAt !== null && bulkExpiresAt <= now) {
          throw new Error("credits_expired");
        }

        if (currentBulkRemaining < uniqueCount) {
          throw new Error("insufficient_bulk_credits");
        }

        t.set(
          creditsDocRef,
          {
            appId,
            ownerUid: appData.ownerUid || null,
            bulk_sms_remaining: currentBulkRemaining - uniqueCount,
            updated_at:
              admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
    } catch (error) {
      setHeaders();
      if (error.message === "insufficient_bulk_credits") {
        return res.status(402).json({
          error: "insufficient_bulk_credits",
          message:
            "Not enough bulk credits. Purchase more at the dashboard.",
        });
      }
      if (error.message === "credits_expired") {
        return res.status(402).json({
          error: "credits_expired",
          message:
            "Bulk credits expired. Purchase a new package.",
        });
      }
      logger.error(
        "[sendBulkSms] credit reservation failed:",
        error,
      );
      return res.status(500).json({
        error: "internal",
        message: "Failed to reserve bulk credits",
      });
    }

    // ── 9. Create campaign + recipients ─────────────────────────────
    const campaignRef = firestore
      .collection("bulk_campaigns")
      .doc(campaignId);
    const recipientCollection =
      campaignRef.collection("recipients");

    const campaignData = {
      id: campaignId,
      appId,
      ownerUid: appData.ownerUid || null,
      campaignName: campaignName.trim(),
      message,
      status: "queued",
      totalRecipients: uniqueCount,
      sentCount: 0,
      failedCount: 0,
      queuedCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: null,
      completedAt: null,
      bulkCreditCost: uniqueCount,
      errorMessage: null,
      nextRecipientIndex: 0,
    };

    let batch = firestore.batch();
    batch.set(campaignRef, campaignData);

    let recipientIndex = 0;
    for (const phone of unique) {
      const recipientRef = recipientCollection.doc();
      batch.set(recipientRef, {
        phone,
        index: recipientIndex,
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
        errorCode: null,
        errorMessage: null,
      });
      recipientIndex += 1;

      if (recipientIndex % 450 === 0) {
        await batch.commit();
        batch = firestore.batch();
      }
    }

    if (recipientIndex % 450 !== 0) {
      await batch.commit();
    }

    // ── 10. RTDB progress + audit ───────────────────────────────────
    await rtdb.ref(`bulk_progress/${campaignId}`).set({
      campaignId,
      sentCount: 0,
      failedCount: 0,
      totalCount: uniqueCount,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
      status: "queued",
    });

    const auditRoot = firestore
      .collection("app_credits")
      .doc(appId)
      .collection("bulk_usage");

    let auditBatch = firestore.batch();
    let auditCount = 0;
    for (const phone of unique) {
      const phoneHash = crypto
        .createHash("sha256")
        .update(phone)
        .digest("hex");
      auditBatch.set(auditRoot.doc(), {
        deducted_at:
          admin.firestore.FieldValue.serverTimestamp(),
        campaign_id: campaignId,
        phone_hash: phoneHash,
      });
      auditCount += 1;

      if (auditCount >= 450) {
        await auditBatch.commit();
        auditBatch = firestore.batch();
        auditCount = 0;
      }
    }
    if (auditCount > 0) {
      await auditBatch.commit();
    }

    // ── 11. Response ────────────────────────────────────────────────
    logger.info("[sendBulkSms] Campaign created", {
      requestId,
      campaignId,
      appId,
      totalRecipients: uniqueCount,
      charset: messageValidation.charset,
    });

    const responseBody = {
      campaignId,
      totalRecipients: uniqueCount,
      creditsReserved: uniqueCount,
      charset: messageValidation.charset,
      status: "queued",
    };

    if (duplicateCount > 0) {
      responseBody.duplicateCount = duplicateCount;
    }

    setHeaders();
    return res.status(200).json(responseBody);
  },
);

module.exports = { sendBulkSms: exports.sendBulkSms };
