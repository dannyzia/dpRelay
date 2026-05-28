const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const db = admin.firestore();
const logger = require("firebase-functions/logger");

/**
 * Helper function to validate appId and appSecret
 * @param {string} appId
 * @param {string} appSecret
 * @returns {Promise<{valid: boolean, appData?: object}>}
 */
async function validateAppCredentials(appId, appSecret) {
  const rtdb = admin.database();
  const appSnapshot = await rtdb.ref(`registered_apps/${appId}`).once("value");

  if (!appSnapshot.exists()) {
    return { valid: false, error: "app_not_found" };
  }

  const appData = appSnapshot.val();

  if (appData.active !== true) {
    return { valid: false, error: "app_revoked" };
  }

  const crypto = require("crypto");
  const expectedHash = crypto
    .createHmac("sha256", process.env.APP_MASTER_SECRET)
    .update(`${appId}${appSecret}`)
    .digest("hex");

  if (!constantTimeEqual(expectedHash, appData.apiKeyHash)) {
    return { valid: false, error: "invalid_credentials" };
  }

  return { valid: true, appData };
}

/**
 * Constant-time comparison to prevent timing attacks
 */
function constantTimeEqual(a, b) {
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
 * POST /getCredits
 *
 * Returns the current credit balance for an authenticated app.
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "appSecret": "32-byte-base64-secret"
 * }
 *
 * Response:
 * {
 *   "sms_remaining": 500,
 *   "expires_at": 1234567890,
 *   "last_package_id": "package-id",
 *   "purchased_at": 1234567890
 * }
 *
 * Response (no credits):
 * {
 *   "sms_remaining": 0,
 *   "expires_at": null,
 *   "last_package_id": null,
 *   "purchased_at": null
 * }
 */
exports.getCredits = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "method_not_allowed",
        message: "Only POST requests are supported",
      });
    }

    const { appId, appSecret } = req.body;

    if (!appId || !appSecret) {
      return res.status(400).json({
        error: "bad_request",
        message: "appId and appSecret are required",
      });
    }

    try {
      const validation = await validateAppCredentials(appId, appSecret);

      if (!validation.valid) {
        const statusCode = validation.error === "app_revoked" ? 403 : 403;
        return res.status(statusCode).json({
          error: validation.error,
          message:
            validation.error === "app_revoked"
              ? "App has been revoked"
              : "Invalid credentials",
        });
      }

      const creditsDoc = await db.collection("app_credits").doc(appId).get();

      if (!creditsDoc.exists) {
        return res.status(200).json({
          sms_remaining: 0,
          otp_remaining: 0,
          bulk_remaining: 0,
          expires_at: null,
          bulk_expires_at: null,
          last_package_id: null,
          purchased_at: null,
        });
      }

      const creditsData = creditsDoc.data();

      return res.status(200).json({
        // Legacy field kept for backwards compatibility with existing integrations
        sms_remaining: creditsData.sms_remaining || 0,
        // Explicit per-type fields (fixes combined-balance display bug)
        otp_remaining: creditsData.sms_remaining || 0,
        bulk_remaining: creditsData.bulk_sms_remaining || 0,
        expires_at: creditsData.expires_at || null,
        bulk_expires_at: creditsData.bulk_expires_at || null,
        last_package_id: creditsData.last_package_id || null,
        purchased_at: creditsData.purchased_at || null,
      });
    } catch (error) {
      logger.error("[getCredits] Error:", error);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to retrieve credits",
      });
    }
  },
);

module.exports = { getCredits: exports.getCredits };
