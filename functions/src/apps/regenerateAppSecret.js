const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const rtdb = admin.database();
const logger = require("firebase-functions/logger");

/**
 * POST /regenerateAppSecret
 *
 * Regenerates a new appSecret for an existing app.
 * Returns the plaintext secret ONCE.
 *
 * Request body:
 * {
 *   "appId": "uuid-v4"
 * }
 *
 * Response:
 * {
 *   "appSecret": "new-32-byte-secret"
 * }
 */
exports.regenerateAppSecret = onRequest(
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

    const { appId } = req.body;
    const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;

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

      const appData = snapshot.val();

      if (appData.active !== true) {
        return res.status(403).json({
          error: "app_revoked",
          message: "App has been revoked",
        });
      }

      const newAppSecret = crypto.randomBytes(32).toString("base64");
      const newApiKeyHash = crypto
        .createHmac("sha256", APP_MASTER_SECRET)
        .update(`${appId}${newAppSecret}`)
        .digest("hex");

      await rtdb.ref(`registered_apps/${appId}`).update({
        apiKeyHash: newApiKeyHash,
        secretRotatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      logger.info(`[regenerateAppSecret] Regenerated secret for app ${appId}`);

      return res.status(200).json({
        appSecret: newAppSecret,
        message: "Store this secret now. It cannot be shown again.",
      });
    } catch (error) {
      logger.error("[regenerateAppSecret] Error:", error);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to regenerate app secret",
      });
    }
  },
);

module.exports = { regenerateAppSecret: exports.regenerateAppSecret };
