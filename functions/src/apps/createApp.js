const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const rtdb = admin.database();
const logger = require('firebase-functions/logger');

/**
 * Callable /createApp
 *
 * Registers a new app in the multi-tenant app registry.
 * Authenticated users only — uses caller's uid as ownerUid.
 * The master secret is handled server-side; the client never sees it.
 *
 * Request data:
 * {
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
exports.createApp = onCall(
  {
    region: 'asia-southeast1',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const uid = request.auth.uid;
    const { appName, smsTemplate, rateLimit } = request.data || {};

    const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;

    if (!APP_MASTER_SECRET) {
      logger.error('[createApp] APP_MASTER_SECRET is not configured');
      throw new HttpsError('internal', 'Server configuration error');
    }

    if (
      !appName ||
      typeof appName !== 'string' ||
      appName.trim().length === 0
    ) {
      throw new HttpsError(
        'invalid-argument',
        'appName is required and must be a non-empty string',
      );
    }

    try {
      const appId = crypto.randomUUID();
      const appSecret = crypto.randomBytes(32).toString('base64');

      const appSecretHash = crypto
        .createHmac('sha256', APP_MASTER_SECRET)
        .update(`${appId}${appSecret}`)
        .digest('hex');

      const finalSmsTemplate =
        smsTemplate && smsTemplate.trim().length > 0
          ? smsTemplate.trim()
          : 'Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.';

      const finalRateLimit =
        rateLimit && typeof rateLimit === 'object'
          ? {
              maxPerPhone: Number(rateLimit.maxPerPhone) || 3,
              windowMs: Number(rateLimit.windowMs) || 600000,
            }
          : { maxPerPhone: 3, windowMs: 600000 };

      const appData = {
        name: appName.trim(),
        ownerUid: uid,
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
        `[createApp] Registered app "${appName}" with ID: ${appId} for user: ${uid}`,
      );

      return {
        appId,
        appSecret,
        message: 'Save appSecret immediately — it will not be shown again',
      };
    } catch (error) {
      logger.error('[createApp] Error:', error);
      throw new HttpsError('internal', 'Failed to register app');
    }
  },
);

module.exports = { createApp: exports.createApp };
