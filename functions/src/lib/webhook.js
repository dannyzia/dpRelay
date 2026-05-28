const crypto = require("crypto");
const admin = require("firebase-admin");
const https = require("https");

/**
 * Sends a webhook notification to an app's configured webhook URL.
 *
 * @param {string} sessionId - The OTP session ID
 * @param {string} status - The OTP status ('sent', 'failed', or 'expired')
 * @param {object} details - Additional details about the status change
 * @returns {Promise<void>}
 */
async function sendWebhook(sessionId, status, details = {}) {
  const db = admin.database();
  const logger = require("firebase-functions/logger");

  try {
    const pendingSnapshot = await db
      .ref(`pending_sms/${sessionId}`)
      .once("value");

    if (!pendingSnapshot.exists()) {
      logger.warn(
        `[sendWebhook] No pending SMS found for sessionId: ${sessionId}`,
      );
      return;
    }

    const pendingData = pendingSnapshot.val();
    const {
      webhookUrl,
      webhookSecretHash,
      appId,
      to: phoneNumber,
    } = pendingData;

    if (!webhookUrl) {
      logger.info(
        `[sendWebhook] No webhook URL configured for appId: ${appId}`,
      );
      return;
    }

    const webhookSecret = process.env[`WEBHOOK_SECRET_${appId}`];
    if (!webhookSecret && !webhookSecretHash) {
      logger.warn(`[sendWebhook] No webhook secret found for appId: ${appId}`);
      return;
    }

    const payload = {
      sessionId,
      status,
      phoneNumber,
      timestamp: Date.now(),
      appId,
      ...details,
    };

    const payloadString = JSON.stringify(payload);

    let signature;
    if (webhookSecret) {
      signature = crypto
        .createHmac("sha256", webhookSecret)
        .update(payloadString)
        .digest("base64");
    } else if (webhookSecretHash) {
      signature = webhookSecretHash;
    }

    const options = {
      hostname: new URL(webhookUrl).hostname,
      port: new URL(webhookUrl).port || 443,
      path: new URL(webhookUrl).pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payloadString),
        "X-Webhook-Signature": signature,
        "User-Agent": "Authenticator-Service/1.0",
      },
      timeout: 5000,
    };

    await attemptWebhookWithRetry(
      options,
      payloadString,
      sessionId,
      appId,
      logger,
    );
  } catch (error) {
    logger.error(
      `[sendWebhook] Error processing webhook for sessionId ${sessionId}:`,
      error,
    );

    await logWebhookFailure(sessionId, error, logger);
  }
}

/**
 * Attempts to send webhook with exponential backoff retry.
 *
 * @param {object} options - HTTPS request options
 * @param {string} payloadString - JSON payload string
 * @param {string} sessionId - Session ID for logging
 * @param {string} appId - App ID for logging
 * @param {object} logger - Firebase logger
 */
async function attemptWebhookWithRetry(
  options,
  payloadString,
  sessionId,
  appId,
  logger,
) {
  const maxRetries = 3;
  const retryDelays = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let data = "";

          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              logger.info(
                `[sendWebhook] Webhook delivered successfully for sessionId ${sessionId} (appId: ${appId}) on attempt ${attempt + 1}`,
              );
              resolve();
            } else {
              reject(
                new Error(`Webhook returned status ${res.statusCode}: ${data}`),
              );
            }
          });
        });

        req.on("error", (error) => {
          reject(error);
        });

        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Webhook request timeout"));
        });

        req.write(payloadString);
        req.end();
      });

      return;
    } catch (error) {
      logger.warn(
        `[sendWebhook] Attempt ${attempt + 1} failed for sessionId ${sessionId}:`,
        error.message,
      );

      if (attempt < maxRetries - 1) {
        const delay = retryDelays[attempt];
        logger.info(`[sendWebhook] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        await logWebhookFailure(sessionId, error, logger);
        logger.error(
          `[sendWebhook] All retry attempts exhausted for sessionId ${sessionId}`,
        );
        throw error;
      }
    }
  }
}

/**
 * Logs webhook failure to RTDB and Firebase Crashlytics.
 *
 * @param {string} sessionId - Session ID
 * @param {Error} error - Error object
 * @param {object} logger - Firebase logger
 */
async function logWebhookFailure(sessionId, error, logger) {
  const db = admin.database();

  try {
    await db.ref(`webhook_failures/${sessionId}`).set({
      sessionId,
      error: error.message,
      errorCode: error.code || "UNKNOWN",
      failedAt: admin.database.ServerValue.TIMESTAMP,
    });

    logger.error(
      `[sendWebhook] Logged webhook failure for sessionId: ${sessionId}`,
    );
  } catch (logError) {
    logger.error(
      `[sendWebhook] Failed to log webhook failure for sessionId ${sessionId}:`,
      logError,
    );
  }
}

module.exports = {
  sendWebhook,
};
