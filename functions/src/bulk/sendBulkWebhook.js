const admin = require("firebase-admin");
const crypto = require("crypto");
const https = require("https");
const logger = require("firebase-functions/logger");

const rtdb = admin.database();

async function sendBulkWebhook(campaignId, appId, results) {
  const appSnapshot = await rtdb.ref(`registered_apps/${appId}`).once("value");

  if (!appSnapshot.exists()) {
    logger.warn(`[sendBulkWebhook] No registered app found for appId=${appId}`);
    return;
  }

  const appData = appSnapshot.val();
  const webhookUrl = appData.webhookUrl;
  const webhookSecretHash = appData.webhookSecretHash;

  if (!webhookUrl) {
    logger.info(`[sendBulkWebhook] No webhook URL configured for appId=${appId}`);
    return;
  }

  const webhookSecret = process.env[`WEBHOOK_SECRET_${appId}`];

  if (!webhookSecret && !webhookSecretHash) {
    logger.warn(`[sendBulkWebhook] No webhook secret configured for appId=${appId}`);
    return;
  }

  const payload = {
    event: "bulk_campaign.completed",
    campaignId,
    appId,
    ...results,
    completedAt: results.completedAt || Date.now(),
  };

  const payloadString = JSON.stringify(payload);
  let signature;

  if (webhookSecret) {
    signature = crypto
      .createHmac("sha256", webhookSecret)
      .update(payloadString)
      .digest("base64");
  } else {
    signature = webhookSecretHash;
  }

  const urlInstance = new URL(webhookUrl);
  const options = {
    hostname: urlInstance.hostname,
    port: urlInstance.port || 443,
    path: `${urlInstance.pathname}${urlInstance.search}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payloadString),
      "X-Webhook-Signature": signature,
      "User-Agent": "Authenticator-Service/1.0",
    },
    timeout: 5000,
  };

  await attemptWebhookWithRetry(options, payloadString, `bulk_${campaignId}`, appId);
}

async function attemptWebhookWithRetry(options, payloadString, failureId, appId) {
  const maxRetries = 3;
  const retryDelays = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
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
                `[sendBulkWebhook] Delivered webhook for appId=${appId} attempt=${attempt + 1}`,
              );
              resolve();
            } else {
              reject(new Error(`Webhook returned status ${res.statusCode}: ${data}`));
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
        `[sendBulkWebhook] Attempt ${attempt + 1} failed for appId=${appId}: ${error.message}`,
      );

      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      } else {
        await logWebhookFailure(failureId, error);
        logger.error(
          `[sendBulkWebhook] Exhausted retries for appId=${appId}, failureId=${failureId}`,
        );
        throw error;
      }
    }
  }
}

async function logWebhookFailure(failureId, error) {
  try {
    await rtdb.ref(`webhook_failures/${failureId}`).set({
      failureId,
      error: error.message,
      errorCode: error.code || "UNKNOWN",
      failedAt: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (logError) {
    logger.error(
      `[sendBulkWebhook] Failed to log webhook failure for ${failureId}:`,
      logError,
    );
  }
}

module.exports = { sendBulkWebhook };
