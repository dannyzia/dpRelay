const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const rtdb = admin.database();
const logger = require("firebase-functions/logger");

/**
 * Constant-time comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
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
 * POST /revokeApp
 *
 * Revokes (soft deletes) an app from the registry.
 * Protected by APP_MASTER_SECRET.
 *
 * Request body:
 * {
 *   "masterSecret": "<APP_MASTER_SECRET>",
 *   "appId": "uuid-v4"
 * }
 *
 * Response:
 * {
 *   "appId": "uuid-v4",
 *   "active": false
 * }
 */
exports.revokeApp = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "method_not_allowed",
      });
    }

    const { masterSecret, appId } = req.body;
    const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;

    if (
      !masterSecret ||
      !timingSafeEqual(masterSecret, APP_MASTER_SECRET || "")
    ) {
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid master secret",
      });
    }

    if (!appId || typeof appId !== "string" || appId.trim().length === 0) {
      return res.status(400).json({
        error: "bad_request",
        message: "appId is required",
      });
    }

    try {
      const snapshot = await rtdb.ref(`registered_apps/${appId}`).once("value");

      if (!snapshot.exists()) {
        return res.status(404).json({
          error: "not_found",
          message: "App not found",
        });
      }

      await rtdb.ref(`registered_apps/${appId}`).update({
        active: false,
        revokedAt: admin.database.ServerValue.TIMESTAMP,
      });

      logger.info(`[revokeApp] Revoked app ${appId}`);

      return res.status(200).json({
        appId,
        active: false,
        message: "App revoked successfully",
      });
    } catch (error) {
      logger.error("[revokeApp] Error:", error);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to revoke app",
      });
    }
  },
);

module.exports = { revokeApp: exports.revokeApp };
