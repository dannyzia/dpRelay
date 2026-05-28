const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

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
 * POST /registerApp
 *
 * Registers a new app in the multi-tenant app registry.
 * Protected by APP_MASTER_SECRET.
 *
 * Request body:
 * {
 *   "masterSecret": "<APP_MASTER_SECRET>",
 *   "appName": "HaatBazar",
 *   "smsTemplate": "Your {appName} code: {otp}. Valid {ttl} minutes.",
 *   "rateLimit": { "maxPerPhone": 3, "windowMs": 600000 }
 * }
 *
 * Response:
 * {
 *   "appId": "uuid-v4",
 *   "appSecret": "32-byte-random-string"
 * }
 */
exports.registerApp = onRequest(
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

    const { masterSecret, appName, smsTemplate, rateLimit, ownerUid } =
      req.body;
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

    if (
      !appName ||
      typeof appName !== "string" ||
      appName.trim().length === 0
    ) {
      return res.status(400).json({
        error: "bad_request",
        message: "appName is required and must be a non-empty string",
      });
    }

    if (
      !ownerUid ||
      typeof ownerUid !== "string" ||
      ownerUid.trim().length === 0
    ) {
      return res.status(400).json({
        error: "bad_request",
        message: "ownerUid is required and must be a non-empty string",
      });
    }

    try {
      const appId = crypto.randomUUID();
      const appSecret = crypto.randomBytes(32).toString("base64");

      const appSecretHash = crypto
        .createHmac("sha256", APP_MASTER_SECRET)
        .update(`${appId}${appSecret}`)
        .digest("hex");

      const finalSmsTemplate =
        smsTemplate && smsTemplate.trim().length > 0
          ? smsTemplate.trim()
          : "Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.";

      const finalRateLimit =
        rateLimit && typeof rateLimit === "object"
          ? {
              maxPerPhone: Number(rateLimit.maxPerPhone) || 3,
              windowMs: Number(rateLimit.windowMs) || 600000,
            }
          : { maxPerPhone: 3, windowMs: 600000 };

      const appData = {
        name: appName.trim(),
        ownerUid,
        apiKeyHash: appSecretHash,
        smsTemplate: finalSmsTemplate,
        rateLimit: finalRateLimit,
        webhookUrl: null,
        webhookSecretHash: null,
        active: true,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      };

      await rtdb.ref(`registered_apps/${appId}`).set(appData);

      logger.info(
        `[registerApp] Registered app "${appName}" with ID: ${appId}`,
      );

      return res.status(200).json({
        appId,
        appSecret,
        message: "Save appSecret immediately - it will not be shown again",
      });
    } catch (error) {
      logger.error("[registerApp] Error:", error);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to register app",
      });
    }
  },
);

module.exports = { registerApp: exports.registerApp };
