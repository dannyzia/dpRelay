const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");

const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;

const firestore = admin.firestore();
const rtdb = admin.database();

/**
 * Constant-time string comparison.
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
 * Validates appId + appSecret against RTDB.
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
 * POST /getBulkStatus
 *
 * Checks the status of a bulk SMS campaign. Authenticates via
 * appId + appSecret (same pattern as /otpStatus).
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "appSecret": "base64-secret",
 *   "campaignId": "uuid-v4"
 * }
 *
 * Success (200):
 * {
 *   "campaignId": "...",
 *   "campaignName": "...",
 *   "status": "sending",
 *   "totalRecipients": 500,
 *   "sentCount": 320,
 *   "failedCount": 5,
 *   "queuedCount": 175,
 *   "createdAt": "2025-01-01T00:00:00Z",
 *   "completedAt": null
 * }
 */
exports.getBulkStatus = onRequest(
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

    const { appId, appSecret, campaignId } = req.body;

    if (!appId || !appSecret || !campaignId) {
      setHeaders();
      return res.status(400).json({
        error: "bad_request",
        message: "appId, appSecret, and campaignId are required",
      });
    }

    // Authenticate
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

    // Fetch campaign
    const campaignDoc = await firestore
      .collection("bulk_campaigns")
      .doc(campaignId)
      .get();

    if (!campaignDoc.exists) {
      setHeaders();
      return res.status(404).json({
        error: "not_found",
        message: "Campaign not found",
      });
    }

    const campaignData = campaignDoc.data();

    // Verify this campaign belongs to the authenticated app
    if (campaignData.appId !== appId) {
      setHeaders();
      return res.status(403).json({
        error: "permission_denied",
        message: "Campaign does not belong to this app",
      });
    }

    // Fetch real-time progress from RTDB
    const progressSnapshot = await rtdb
      .ref(`bulk_progress/${campaignId}`)
      .once("value");
    const progress = progressSnapshot.exists()
      ? progressSnapshot.val()
      : null;

    const sentCount = progress
      ? Number(progress.sentCount || 0)
      : Number(campaignData.sentCount || 0);
    const failedCount = progress
      ? Number(progress.failedCount || 0)
      : Number(campaignData.failedCount || 0);

    setHeaders();
    return res.status(200).json({
      campaignId: campaignData.id,
      campaignName: campaignData.campaignName,
      status: campaignData.status,
      totalRecipients: campaignData.totalRecipients,
      sentCount,
      failedCount,
      queuedCount:
        campaignData.totalRecipients - sentCount - failedCount,
      createdAt: campaignData.createdAt || null,
      completedAt: campaignData.completedAt || null,
      charset: progress?.charset || null,
    });
  },
);

module.exports = { getBulkStatus: exports.getBulkStatus };
