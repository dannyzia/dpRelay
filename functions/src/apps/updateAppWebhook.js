const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const rtdb = admin.database();
const logger = require("firebase-functions/logger");

/**
 * POST /updateAppWebhook
 *
 * Updates webhook URL and optionally regenerates webhook secret.
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "webhookUrl": "https://example.com/webhook",
 *   "regenerateSecret": false
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "webhookSecret": "new-secret-if-regenerated"
 * }
 */
exports.updateAppWebhook = onRequest(
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

    const { appId, webhookUrl, regenerateSecret } = req.body;
    const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;

    if (!appId || typeof appId !== "string" || appId.trim().length === 0) {
      return res.status(400).json({
        error: "bad_request",
        message: "appId is required",
      });
    }

    if (
      !webhookUrl ||
      typeof webhookUrl !== "string" ||
      webhookUrl.trim().length === 0
    ) {
      return res.status(400).json({
        error: "bad_request",
        message: "webhookUrl is required",
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

      const updates = {
        webhookUrl: webhookUrl.trim(),
      };

      let newWebhookSecret = null;

      if (regenerateSecret === true) {
        newWebhookSecret = crypto.randomBytes(32).toString("hex");
        const webhookSecretHash = crypto
          .createHmac("sha256", APP_MASTER_SECRET)
          .update(`${appId}${newWebhookSecret}`)
          .digest("hex");
        updates.webhookSecretHash = webhookSecretHash;

        logger.info(
          `[updateAppWebhook] Regenerated webhook secret for app ${appId}`,
        );
      }

      await rtdb.ref(`registered_apps/${appId}`).update(updates);

      const response = {
        success: true,
      };

      if (newWebhookSecret) {
        response.webhookSecret = newWebhookSecret;
      }

      logger.info(`[updateAppWebhook] Updated webhook for app ${appId}`);

      return res.status(200).json(response);
    } catch (error) {
      logger.error("[updateAppWebhook] Error:", error);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to update webhook",
      });
    }
  },
);

module.exports = { updateAppWebhook: exports.updateAppWebhook };
