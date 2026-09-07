// Deploy v5.0.0 - Billing + Webhooks + Credit Check
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const crypto = require("crypto");
const logger = require("firebase-functions/logger");
const { resolveOtpSessionRecord } = require("./src/lib/otpSessionResolver");

const serviceAccount = require("./authenticator-15fb7-36cfda9edf3b.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://authenticator-15fb7-default-rtdb.asia-southeast1.firebasedatabase.app",
});

// Firestore instance (FS-01)
const firestore = admin.firestore();

// Constants
const CLOCK_SKEW_MS = 300000; // 5 minutes
const VERIFICATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_START_VERIFICATION = 10; // 10 requests per 15 minutes
const RATE_LIMIT_CHECK_AUTH = 30; // 30 requests per minute
const RATE_LIMIT_WINDOW_START_VERIFICATION = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_WINDOW_CHECK_AUTH = 60 * 1000; // 1 minute

// Secrets using environment variables (Spark plan compatible)
const VERIFICATION_SIGNING_SECRET = process.env.VERIFICATION_SIGNING_SECRET;
const AUTHENTICATOR_ENROLLMENT_SECRET =
  process.env.AUTHENTICATOR_ENROLLMENT_SECRET;
const HEALTH_ADMIN_SECRET = process.env.HEALTH_ADMIN_SECRET;
const ACTIVE_DEDICATED_NUMBER = process.env.ACTIVE_DEDICATED_NUMBER;
const APP_MASTER_SECRET = process.env.APP_MASTER_SECRET;
const RIDE_BACKEND_URL = process.env.RIDE_BACKEND_URL;
const DPRELAY_INBOUND_SECRET = process.env.DPRELAY_INBOUND_SECRET;
// BKASH_PERSONAL_NUMBER and BKASH_MIN_TOPUP_AMOUNT are read directly from process.env
// by the billing module files (requestCredit.js, seedPackages.js)

// Rate limiting store (in-memory - for production, use Redis)
const rateLimitStore = new Map();

/**
 * Rate limiting helper.
 * @param {string} key - Unique key for the rate limit (e.g., IP address)
 * @param {number} maxRequests - Maximum allowed requests
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Object} - { limited: boolean, resetTime: number }
 */
function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;

  let requests = rateLimitStore.get(key) || [];

  // Filter out requests outside the window
  requests = requests.filter((timestamp) => timestamp > windowStart);

  if (requests.length >= maxRequests) {
    // Calculate reset time (oldest request + window duration)
    const oldestRequest = requests[0];
    const resetTime = oldestRequest + windowMs;
    return { limited: true, resetTime };
  }

  // Add current request
  requests.push(now);
  rateLimitStore.set(key, requests);

  return { limited: false, resetTime: now + windowMs };
}

/**
 * Constant-time comparison to prevent timing attacks.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} - true if strings are equal
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
 * Generates HMAC-SHA256 signature (base64).
 * Used for poll tokens and OTP hashing — NOT for app credential validation.
 * App credentials use hex digest to match registerApp/regenerateAppSecret modules.
 * @param {string} secret - Secret key
 * @param {string} data - Data to sign
 * @returns {string} - Base64-encoded signature
 */
function generateHmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64");
}

/**
 * Generates a cryptographically secure session code.
 * @returns {string} - 10-character uppercase hex string
 */
function generateSessionCode() {
  const bytes = crypto.randomBytes(10);
  const chars = "0123456789ABCDEF";
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    const index = bytes[i] % chars.length;
    code += chars[index];
  }
  return code;
}

/**
 * Validates clock skew.
 * @param {number} timestamp - Timestamp to validate
 * @returns {boolean} - true if within clock skew
 */
function isWithinClockSkew(timestamp) {
  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  return diff <= CLOCK_SKEW_MS;
}

/**
 * Validates app credentials by checking appId + appSecret against the RTDB registry.
 * @param {string} appId - App ID
 * @param {string} appSecret - App secret (plaintext)
 * @returns {Promise<{valid: boolean, appData?: object, error?: string}>}
 */
async function validateAppCredentials(appId, appSecret) {
  const db = admin.database();
  const appSnapshot = await db.ref(`registered_apps/${appId}`).once("value");

  if (!appSnapshot.exists()) {
    return { valid: false, error: "app_not_found" };
  }

  const appData = appSnapshot.val();

  if (appData.active !== true) {
    return { valid: false, error: "app_revoked" };
  }

  // Must use hex digest to match registerApp/regenerateAppSecret module files
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
 * Consumes a one-time verify success receipt for a just-completed OTP session.
 * This allows one identical retry to return the original success response
 * without keeping the live OTP session around for replay.
 * @param {object} db Firebase RTDB instance.
 * @param {string} sessionId OTP session id.
 * @param {string} appId Caller app id.
 * @param {string} otp Submitted OTP.
 * @returns {Promise<{phoneNumber: string}|null>} Matching replay receipt or null.
 */
async function consumeOtpVerifyReceipt(db, sessionId, appId, otp) {
  const receiptRef = db.ref(`otp_verify_receipts/${sessionId}`);
  const computedHash = generateHmac(
    VERIFICATION_SIGNING_SECRET,
    `${sessionId}${otp}`,
  );
  let matchedPhoneNumber = null;

  const { committed } = await receiptRef.transaction((currentReceipt) => {
    if (!currentReceipt) {
      return undefined;
    }

    if (
      currentReceipt.appId !== appId ||
      currentReceipt.replayAvailable !== true
    ) {
      return undefined;
    }

    if (Date.now() > currentReceipt.expiresAt) {
      return null;
    }

    if (!timingSafeEqual(computedHash, currentReceipt.hashedOtp)) {
      return undefined;
    }

    matchedPhoneNumber = currentReceipt.phoneNumber;
    return null;
  });

  if (committed && matchedPhoneNumber) {
    return { phoneNumber: matchedPhoneNumber };
  }

  if (committed) {
    return null;
  }

  const recheckSnap = await receiptRef.once("value");
  if (!recheckSnap.exists()) {
    return null;
  }

  const receipt = recheckSnap.val();
  if (
    !receipt ||
    receipt.appId !== appId ||
    receipt.replayAvailable !== true ||
    Date.now() > receipt.expiresAt ||
    !timingSafeEqual(computedHash, receipt.hashedOtp)
  ) {
    return null;
  }

  await receiptRef.remove();
  return { phoneNumber: receipt.phoneNumber };
}

/**
 * Sends a webhook notification for OTP status changes.
 * Fire-and-forget: does not block the caller, logs errors internally.
 * @param {string} sessionId - The OTP session ID
 * @param {string} status - The OTP status ('sent', 'failed', or 'expired')
 * @param {object} details - Additional details about the status change
 */
function fireWebhook(sessionId, status, details = {}) {
  const sendWebhook = require("./src/lib/webhook").sendWebhook;
  sendWebhook(sessionId, status, details).catch((err) => {
    logger.error(`[fireWebhook] Failed for sessionId=${sessionId}:`, err);
  });
}

async function processPaymentSmsPayload(event) {
  const pushId = event.params?.pushId;
  const data = event.data?.val();

  if (!pushId || !data) {
    return null;
  }

  const { txn_id, amount_bdt, provider, received_at } = data;
  const paymentRef = admin.database().ref(`payment_sms/${pushId}`);

  if (typeof txn_id !== "string" || !/^[A-Z0-9]{10}$/.test(txn_id)) {
    logger.error("onPaymentSmsReceived: invalid txn_id", { pushId });
    await paymentRef.delete();
    return null;
  }

  if (!Number.isInteger(amount_bdt) || amount_bdt <= 0) {
    logger.error("onPaymentSmsReceived: invalid amount_bdt", {
      pushId,
      amount_bdt,
    });
    await paymentRef.delete();
    return null;
  }

  if (provider !== "bkash" && provider !== "nagad") {
    logger.error("onPaymentSmsReceived: unknown provider", {
      pushId,
      provider,
    });
    await paymentRef.delete();
    return null;
  }

  if (!RIDE_BACKEND_URL || !DPRELAY_INBOUND_SECRET) {
    logger.error("onPaymentSmsReceived: missing required secret env");
    throw new Error("Missing RIDE_BACKEND_URL or DPRELAY_INBOUND_SECRET");
  }

  const response = await fetch(`${RIDE_BACKEND_URL}/api/payment/sms-confirm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-dprelay-secret": DPRELAY_INBOUND_SECRET,
    },
    body: JSON.stringify({ txn_id, amount_bdt, provider, received_at }),
  });

  if (response.ok) {
    logger.info("onPaymentSmsReceived: confirmed by Ride backend", {
      pushId,
      provider,
      txn_id_length: txn_id.length,
    });
    await paymentRef.delete();
    return null;
  }

  if (response.status === 404) {
    logger.warn(
      "onPaymentSmsReceived: Ride backend returned 404 — no matching payment event",
      { pushId, provider },
    );
    await paymentRef.delete();
    return null;
  }

  if (response.status === 409) {
    logger.info("onPaymentSmsReceived: already confirmed (409)", { pushId });
    await paymentRef.delete();
    return null;
  }

  logger.error("onPaymentSmsReceived: Ride backend error — will retry", {
    pushId,
    status: response.status,
  });
  throw new Error(`Ride backend returned ${response.status}`);
}

exports.processPaymentSmsPayload = processPaymentSmsPayload;

exports.onPaymentSmsReceived = onValueCreated(
  {
    region: "asia-southeast1",
    ref: "/payment_sms/{pushId}",
  },
  processPaymentSmsPayload,
);

// ============================================================
// PHASE 1: Original Authenticator Device Functions
// ============================================================

/**
 * POST /v4/startVerification
 *
 * Initiates a phone number verification.
 */
exports.startVerification = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const ip = req.ip || req.connection.remoteAddress;
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const rateLimitResult = isRateLimited(
      ip,
      RATE_LIMIT_START_VERIFICATION,
      RATE_LIMIT_WINDOW_START_VERIFICATION,
    );
    if (rateLimitResult.limited) {
      const resetSeconds = Math.ceil(
        (rateLimitResult.resetTime - Date.now()) / 1000,
      );
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      res.setHeader("Retry-After", resetSeconds.toString());
      res.setHeader(
        "X-RateLimit-Limit",
        RATE_LIMIT_START_VERIFICATION.toString(),
      );
      res.setHeader("X-RateLimit-Reset", rateLimitResult.resetTime.toString());
      return res.status(429).json({
        verified: false,
        error: "rate_limited",
      });
    }

    const { phoneNumber, clientTimestamp } = req.body;

    if (!phoneNumber || !clientTimestamp) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    if (!isWithinClockSkew(clientTimestamp)) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    try {
      const sessionCode = generateSessionCode();
      const expiresAt = Date.now() + VERIFICATION_TTL_MS;
      const challengeToken = generateSessionCode();
      const dedicatedNumber = ACTIVE_DEDICATED_NUMBER;

      const smsBody = `AUTH:${sessionCode}:${expiresAt}:${challengeToken}`;

      const pollToken = generateHmac(
        VERIFICATION_SIGNING_SECRET,
        `POLL:${sessionCode}:${phoneNumber}:${expiresAt}`,
      );

      const db = admin.database();
      await db.ref(`verification_requests/${sessionCode}`).set({
        userPhone: phoneNumber,
        createdAt: admin.database.ServerValue.TIMESTAMP,
        expiresAt,
        challengeToken,
      });

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);
      res.setHeader(
        "X-RateLimit-Limit",
        RATE_LIMIT_START_VERIFICATION.toString(),
      );
      res.setHeader(
        "X-RateLimit-Remaining",
        (RATE_LIMIT_START_VERIFICATION - 1).toString(),
      );
      res.setHeader("X-RateLimit-Reset", rateLimitResult.resetTime.toString());

      return res.status(200).json({
        sessionCode,
        smsBody,
        dedicatedNumber,
        expiresAt,
        pollToken,
      });
    } catch (error) {
      logger.error("startVerification error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        verified: false,
        error: "integrity_error",
      });
    }
  },
);

/**
 * POST /v4/checkAuth
 *
 * Checks if verification is complete.
 */
exports.checkAuth = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const ip = req.ip || req.connection.remoteAddress;
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const rateLimitResult = isRateLimited(
      ip,
      RATE_LIMIT_CHECK_AUTH,
      RATE_LIMIT_WINDOW_CHECK_AUTH,
    );
    if (rateLimitResult.limited) {
      const resetSeconds = Math.ceil(
        (rateLimitResult.resetTime - Date.now()) / 1000,
      );
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      res.setHeader("Retry-After", resetSeconds.toString());
      res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CHECK_AUTH.toString());
      res.setHeader("X-RateLimit-Reset", rateLimitResult.resetTime.toString());
      return res.status(429).json({
        verified: false,
        error: "rate_limited",
      });
    }

    const { sessionCode, pollToken } = req.body;

    if (!sessionCode || !pollToken) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    if (!sessionCode.match(/^[0-9A-F]{10}$/)) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    try {
      const db = admin.database();
      const snapshot = await db
        .ref(`verification_requests/${sessionCode}`)
        .once("value");

      if (!snapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          verified: false,
          reason: "expired",
          sessionCode,
        });
      }

      const data = snapshot.val();
      const userPhone = data.userPhone;

      if (Date.now() > data.expiresAt) {
        await db.ref(`verification_requests/${sessionCode}`).remove();
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          verified: false,
          reason: "expired",
          sessionCode,
        });
      }

      const expectedPollToken = generateHmac(
        VERIFICATION_SIGNING_SECRET,
        `POLL:${sessionCode}:${userPhone}:${data.expiresAt}`,
      );
      if (!timingSafeEqual(pollToken, expectedPollToken)) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          verified: false,
          error: "invalid_poll_token",
        });
      }

      if (data.receipt) {
        const { sender, challengeToken } = data.receipt;

        if (!timingSafeEqual(challengeToken, data.challengeToken)) {
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          return res.status(403).json({
            verified: false,
            error: "invalid_challenge",
          });
        }

        if (!timingSafeEqual(sender, userPhone)) {
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          return res.status(200).json({
            verified: false,
            reason: "mismatch",
            sessionCode,
          });
        }

        await db.ref(`verification_requests/${sessionCode}`).remove();

        const processingTime = Date.now() - startTime;
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${processingTime}`);
        res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CHECK_AUTH.toString());
        res.setHeader(
          "X-RateLimit-Remaining",
          (RATE_LIMIT_CHECK_AUTH - 1).toString(),
        );
        res.setHeader(
          "X-RateLimit-Reset",
          rateLimitResult.resetTime.toString(),
        );

        return res.status(200).json({
          verified: true,
          sender,
          sessionCode,
          processedAt: Date.now(),
        });
      }

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);
      res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CHECK_AUTH.toString());
      res.setHeader(
        "X-RateLimit-Remaining",
        (RATE_LIMIT_CHECK_AUTH - 1).toString(),
      );
      res.setHeader("X-RateLimit-Reset", rateLimitResult.resetTime.toString());

      return res.status(200).json({
        verified: false,
        status: "pending",
      });
    } catch (error) {
      logger.error("checkAuth error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        verified: false,
        error: "integrity_error",
      });
    }
  },
);

/**
 * POST /v4/registerAuthenticator
 *
 * Registers an authenticator device and returns a Firebase custom token.
 */
exports.registerAuthenticator = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(403).json({
        verified: false,
        error: "unauthorized_device",
      });
    }

    const providedSecret = authHeader.substring(7);

    if (!timingSafeEqual(providedSecret, AUTHENTICATOR_ENROLLMENT_SECRET)) {
      return res.status(403).json({
        verified: false,
        error: "unauthorized_device",
      });
    }

    const { androidId, model } = req.body;

    if (!androidId || !model) {
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    try {
      const customToken = await admin.auth().createCustomToken(androidId, {
        role: "authenticator",
        model,
      });

      return res.status(200).json({
        firebaseCustomToken: customToken,
      });
    } catch (error) {
      logger.error("registerAuthenticator error:", error);
      return res.status(500).json({
        verified: false,
        error: "integrity_error",
      });
    }
  },
);

/**
 * POST /health
 *
 * Health check endpoint.
 */
exports.health = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(403).json({
        verified: false,
        error: "unauthorized_device",
      });
    }

    const providedSecret = authHeader.substring(7);

    if (!timingSafeEqual(providedSecret, HEALTH_ADMIN_SECRET)) {
      return res.status(403).json({
        verified: false,
        error: "unauthorized_device",
      });
    }

    try {
      const db = admin.database();

      const now = Date.now();
      const activeCutoff = now - 5 * 60 * 1000;

      const healthSnapshot = await db.ref("health").once("value");
      let activeDevices = 0;

      if (healthSnapshot.exists()) {
        healthSnapshot.forEach((childSnapshot) => {
          const data = childSnapshot.val();
          if (data.lastPing > activeCutoff) {
            activeDevices++;
          }
        });
      }

      const queueSnapshot = await db.ref("verification_requests").once("value");
      let queueDepth = 0;

      if (queueSnapshot.exists()) {
        queueSnapshot.forEach((childSnapshot) => {
          const data = childSnapshot.val();
          if (!data.receipt && data.expiresAt > now) {
            queueDepth++;
          }
        });
      }

      const isHealthy = activeDevices >= 1 && queueDepth <= 100;

      return res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? "healthy" : "unhealthy",
        timestamp: now,
        activeDevices,
        queueDepth,
      });
    } catch (error) {
      logger.error("health error:", error);
      return res.status(500).json({
        verified: false,
        error: "integrity_error",
      });
    }
  },
);

// ============================================================
// PHASE 2: Scheduled Jobs
// ============================================================

/**
 * Scheduled function to clean up old verification requests, expired OTP requests,
 * and old webhook failure logs (WH-04).
 * Runs daily at midnight Asia/Dhaka.
 */
exports.cleanupOldRequests = onSchedule(
  {
    schedule: "0 0 * * *",
    region: "asia-southeast1",
    timeZone: "Asia/Dhaka",
  },
  async (_event) => {
    const db = admin.database();
    const now = Date.now();
    const cutoff = now - VERIFICATION_TTL_MS;

    try {
      // Clean up old verification_requests
      const snapshot = await db
        .ref("verification_requests")
        .orderByChild("createdAt")
        .endAt(cutoff)
        .once("value");

      if (snapshot.exists()) {
        const updates = {};

        snapshot.forEach((childSnapshot) => {
          updates[childSnapshot.key] = null;
        });

        if (Object.keys(updates).length > 0) {
          await db.ref("verification_requests").update(updates);
          logger.info(
            `Cleaned up ${Object.keys(updates).length} old verification requests`,
          );
        }
      }

      // Clean up expired otp_requests (based on expiresAt, not createdAt)
      const otpSnapshot = await db
        .ref("otp_requests")
        .orderByChild("expiresAt")
        .endAt(now)
        .once("value");

      if (otpSnapshot.exists()) {
        const otpUpdates = {};

        otpSnapshot.forEach((childSnapshot) => {
          otpUpdates[childSnapshot.key] = null;
        });

        if (Object.keys(otpUpdates).length > 0) {
          await db.ref("otp_requests").update(otpUpdates);
          logger.info(
            `Cleaned up ${Object.keys(otpUpdates).length} expired OTP requests`,
          );
        }
      }

      const otpReceiptSnapshot = await db
        .ref("otp_verify_receipts")
        .orderByChild("expiresAt")
        .endAt(now)
        .once("value");

      if (otpReceiptSnapshot.exists()) {
        const otpReceiptUpdates = {};

        otpReceiptSnapshot.forEach((childSnapshot) => {
          otpReceiptUpdates[childSnapshot.key] = null;
        });

        if (Object.keys(otpReceiptUpdates).length > 0) {
          await db.ref("otp_verify_receipts").update(otpReceiptUpdates);
          logger.info(
            `Cleaned up ${Object.keys(otpReceiptUpdates).length} expired OTP verify receipts`,
          );
        }
      }

      // WH-04: Clean up webhook_failures older than 7 days
      const webhookCutoff = now - 7 * 24 * 60 * 60 * 1000;
      const webhookSnapshot = await db
        .ref("webhook_failures")
        .orderByChild("failedAt")
        .endAt(webhookCutoff)
        .once("value");

      if (webhookSnapshot.exists()) {
        const webhookUpdates = {};

        webhookSnapshot.forEach((childSnapshot) => {
          webhookUpdates[childSnapshot.key] = null;
        });

        if (Object.keys(webhookUpdates).length > 0) {
          await db.ref("webhook_failures").update(webhookUpdates);
          logger.info(
            `Cleaned up ${Object.keys(webhookUpdates).length} old webhook failure logs`,
          );
        }
      }

      // Clean up expired otp_cooldown nodes.
      // Each node has an `expiresAt` epoch-ms field set 30 s after creation.
      // Full scan is fine — entries only live for 30 s; this GC is insurance
      // against orphaned nodes (e.g. from a function crash mid-write).
      const cooldownSnapshot = await db.ref("otp_cooldown").once("value");
      if (cooldownSnapshot.exists()) {
        const cooldownUpdates = {};
        cooldownSnapshot.forEach((child) => {
          const d = child.val();
          // Delete if expiresAt is missing or already in the past.
          if (!d || !d.expiresAt || d.expiresAt <= now) {
            cooldownUpdates[child.key] = null;
          }
        });
        if (Object.keys(cooldownUpdates).length > 0) {
          await db.ref("otp_cooldown").update(cooldownUpdates);
          logger.info(
            `Cleaned up ${Object.keys(cooldownUpdates).length} expired otp_cooldown entries`,
          );
        }
      }
    } catch (error) {
      logger.error("cleanupOldRequests error:", error);
    }
  },
);

// ============================================================
// PHASE 1/AD-03: Admin Claim Function
// ============================================================

/**
 * POST /setAdminClaim
 *
 * Assigns admin custom claim to a Firebase user.
 * Protected by APP_MASTER_SECRET.
 * Called once during initial setup.
 *
 * Request body:
 * {
 *   "masterSecret": "<APP_MASTER_SECRET>",
 *   "uid": "<firebase-user-uid>"
 * }
 */
exports.setAdminClaim = onRequest(
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

    const { masterSecret, uid } = req.body;

    if (
      !masterSecret ||
      !timingSafeEqual(masterSecret, APP_MASTER_SECRET || "")
    ) {
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid master secret",
      });
    }

    if (!uid || typeof uid !== "string" || uid.trim().length === 0) {
      return res.status(400).json({
        error: "bad_request",
        message: "uid is required",
      });
    }

    try {
      await admin.auth().setCustomUserClaims(uid, { admin: true });

      logger.info(`[setAdminClaim] Admin claim set for uid: ${uid}`);

      return res.status(200).json({
        success: true,
        message: `Admin claim set for user ${uid}`,
      });
    } catch (error) {
      logger.error("[setAdminClaim] Error:", error);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to set admin claim",
      });
    }
  },
);

// ============================================================
// PHASE 1: App Management (re-exported from modules)
// ============================================================

/**
 * POST /registerApp — re-exported from module.
 * Registers a new app in the multi-tenant app registry.
 */
const { registerApp: _registerApp } = require("./src/apps/registerApp");
exports.registerApp = _registerApp;

/**
 * Callable /createApp — re-exported from module.
 * Dashboard-facing callable for registering a new app.
 * Uses caller's auth uid as ownerUid (no masterSecret required from client).
 */
const { createApp: _createApp } = require("./src/apps/createApp");
exports.createApp = _createApp;

/**
 * POST /revokeApp — re-exported from module.
 * Revokes (soft deletes) an app from the registry.
 */
const { revokeApp: _revokeApp } = require("./src/apps/revokeApp");
exports.revokeApp = _revokeApp;

/**
 * POST /updateAppWebhook — re-exported from module.
 * Updates webhook URL and optionally regenerates webhook secret.
 */
const {
  updateAppWebhook: _updateAppWebhook,
} = require("./src/apps/updateAppWebhook");
exports.updateAppWebhook = _updateAppWebhook;

/**
 * POST /regenerateAppSecret — re-exported from module.
 * Regenerates appSecret for an existing app.
 */
const {
  regenerateAppSecret: _regenerateAppSecret,
} = require("./src/apps/regenerateAppSecret");
exports.regenerateAppSecret = _regenerateAppSecret;

// ============================================================
// PHASE 6/7: OTP Functions (with credit check + webhooks)
// ============================================================

/**
 * POST /v4/sendOtp
 *
 * Initiates an OTP verification by sending an SMS to the user's phone.
 * Multi-tenant: each app must identify itself with appId + appSecret.
 * Credit check (CR-01): reads Firestore app_credits before generating OTP.
 * Credit deduction (CR-02): Firestore transaction to decrement sms_remaining.
 * Usage audit (CR-03): writes to app_credits/{appId}/usage sub-collection.
 * Webhook data (WH-01): copies webhookUrl + webhookSecretHash into pending_sms.
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "appSecret": "32-byte-base64-secret",
 *   "phoneNumber": "+8801712345678"
 * }
 *
 * Response:
 * {
 *   "sessionId": "uuid-v4",
 *   "expiresAt": 1234567890
 * }
 */
exports.sendOtp = onRequest(
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

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { appId, appSecret, phoneNumber } = req.body;

    // Validation
    if (!appId || !appSecret || !phoneNumber) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        error: "bad_request",
        message: "appId, appSecret, and phoneNumber are required",
      });
    }

    // Validate phone number format (E.164)
    if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        error: "bad_request",
        message:
          "Invalid phone number format. Use E.164 format (e.g., +8801712345678)",
      });
    }

    try {
      const db = admin.database();

      // Kill switch: check /config/sms_paused before doing ANY work.
      // Set this node to `true` in RTDB console to halt all OTP sending instantly.
      const pausedSnap = await db.ref("config/sms_paused").once("value");
      if (pausedSnap.val() === true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(503).json({
          error: "service_paused",
          message: "SMS sending is temporarily paused. Please try again later.",
        });
      }

      // Step 1: Read /registered_apps/{appId} and validate credentials
      const validation = await validateAppCredentials(appId, appSecret);

      if (!validation.valid) {
        const statusCode = validation.error === "app_revoked" ? 403 : 403;
        const message =
          validation.error === "app_revoked"
            ? "App has been revoked"
            : validation.error === "app_not_found"
              ? "App not found or invalid appId"
              : "Invalid appSecret";

        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(statusCode).json({
          error: validation.error,
          message,
        });
      }

      const appData = validation.appData;

      // CR-01: Credit check — read Firestore app_credits/{appId}
      const creditsDoc = await firestore
        .collection("app_credits")
        .doc(appId)
        .get();

      if (!creditsDoc.exists) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(402).json({
          error: "no_credits",
          message:
            "No credit package purchased. Visit the dashboard to buy credits.",
        });
      }

      const creditsData = creditsDoc.data();

      if (!creditsData.sms_remaining || creditsData.sms_remaining <= 0) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(402).json({
          error: "no_credits",
          message: "Out of SMS credits. Please top up.",
        });
      }

      // Check expiry — expires_at is stored as Firestore Timestamp or number
      const expiresAtMs = creditsData.expires_at;
      const expiresAtValue =
        typeof expiresAtMs === "object" &&
        expiresAtMs !== null &&
        expiresAtMs._seconds !== undefined
          ? expiresAtMs._seconds * 1000 +
            (expiresAtMs._nanoseconds || 0) / 1000000
          : Number(expiresAtMs);

      if (!expiresAtValue || expiresAtValue < Date.now()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(402).json({
          error: "credits_expired",
          message: "Credit package expired. Please purchase a new one.",
        });
      }

      // Step 3: Read rateLimit from app config (fallback to defaults)
      const rateLimit = appData.rateLimit || {
        maxPerPhone: 3,
        windowMs: 600000,
      };
      const maxPerPhone = rateLimit.maxPerPhone || 3;
      const windowMs = rateLimit.windowMs || 600000;

      // Step 4: Enforce per-phone, per-app rate limit
      const rateLimitKey = `${appId}+${phoneNumber}`;
      const rateLimitResult = isRateLimited(
        rateLimitKey,
        maxPerPhone,
        windowMs,
      );

      if (rateLimitResult.limited) {
        const resetSeconds = Math.ceil(
          (rateLimitResult.resetTime - Date.now()) / 1000,
        );
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        res.setHeader("Retry-After", resetSeconds.toString());
        return res.status(429).json({
          error: "rate_limited",
          message: "Too many OTP requests. Please try again later.",
        });
      }

      // Step 4b: RTDB-based per-phone cooldown (30 s).
      // Prevents the same phone from receiving a new OTP within 30 seconds even
      // across multiple Cloud Function instances (in-memory rate limiter is
      // per-instance only). The key uses a truncated SHA-256 of the phone number
      // so raw phone numbers are never stored as RTDB node names.
      const phoneCooldownHash = crypto
        .createHash("sha256")
        .update(phoneNumber)
        .digest("hex")
        .substring(0, 32);
      const cooldownRef = db.ref(`otp_cooldown/${phoneCooldownHash}`);
      const cooldownSnap = await cooldownRef.once("value");
      if (cooldownSnap.exists()) {
        const cooldownData = cooldownSnap.val();
        if (cooldownData && cooldownData.expiresAt > Date.now()) {
          const waitSeconds = Math.ceil(
            (cooldownData.expiresAt - Date.now()) / 1000,
          );
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          res.setHeader("Retry-After", waitSeconds.toString());
          return res.status(429).json({
            error: "cooldown",
            message: `Please wait ${waitSeconds} second(s) before requesting another OTP for this number.`,
            waitSeconds,
          });
        }
      }

      // Step 5: Generate 6-digit OTP
      const otp = crypto.randomInt(100000, 999999);

      // Generate session ID
      const sessionId = crypto.randomUUID();

      // Step 6: Compute hashedOtp = HMAC(VERIFICATION_SIGNING_SECRET, sessionId+otp)
      const hashedOtp = generateHmac(
        VERIFICATION_SIGNING_SECRET,
        `${sessionId}${otp}`,
      );

      // Step 7: Compute expiresAt (default 10 minutes)
      const ttlMs = 10 * 60 * 1000;
      const otpExpiresAt = Date.now() + ttlMs;
      const ttlMinutes = Math.floor(ttlMs / 60000);

      // Step 7b: Arm the 30-second cooldown for this phone number.
      // Done before writing the OTP so the lock is in place even if a
      // concurrent request reads the cooldown node at the same moment.
      await cooldownRef.set({
        expiresAt: Date.now() + 30000,
        appId,
      });

      // Step 8: Write /otp_requests/{sessionId}
      await db.ref(`otp_requests/${sessionId}`).set({
        appId,
        phoneNumber,
        hashedOtp,
        createdAt: admin.database.ServerValue.TIMESTAMP,
        expiresAt: otpExpiresAt,
        attempts: 0,
        locked: false,
      });

      // Step 9: Read smsTemplate and render
      const smsTemplate =
        appData.smsTemplate ||
        "Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.";

      const message = smsTemplate
        .replace("{appName}", appData.name)
        .replace("{otp}", otp.toString())
        .replace("{ttl}", ttlMinutes.toString());

      // Step 10: Write /pending_sms/{sessionId}
      // OTP jobs do not set batchId — it remains null/undefined.
      // Bulk jobs (via processBulkQueue) set batchId to campaignId.
      // WH-01: Include webhookUrl and webhookSecretHash from app registry
      const pendingSmsData = {
        appId,
        to: phoneNumber,
        message,
        status: "pending",
        createdAt: admin.database.ServerValue.TIMESTAMP,
      };

      if (appData.webhookUrl) {
        pendingSmsData.webhookUrl = appData.webhookUrl;
      }
      if (appData.webhookSecretHash) {
        pendingSmsData.webhookSecretHash = appData.webhookSecretHash;
      }

      await db.ref(`pending_sms/${sessionId}`).set(pendingSmsData);

      // CR-02: Firestore transaction to decrement sms_remaining
      try {
        await firestore.runTransaction(async (t) => {
          const creditsRef = firestore.collection("app_credits").doc(appId);
          const creditsDocSnap = await t.get(creditsRef);

          if (!creditsDocSnap.exists) {
            throw new Error("no_credits");
          }

          const currentData = creditsDocSnap.data();
          const currentRemaining = currentData.sms_remaining || 0;

          if (currentRemaining <= 0) {
            throw new Error("no_credits");
          }

          t.update(creditsRef, {
            sms_remaining: currentRemaining - 1,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
      } catch (txError) {
        // Transaction failed (concurrent call raced to 0)
        if (txError.message === "no_credits") {
          // Clean up the RTDB records we just created
          const cleanupUpdates = {};
          cleanupUpdates[`otp_requests/${sessionId}`] = null;
          cleanupUpdates[`pending_sms/${sessionId}`] = null;
          await db.ref().update(cleanupUpdates);

          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          return res.status(402).json({
            error: "no_credits",
            message: "Out of SMS credits. Please top up.",
          });
        }
        throw txError;
      }

      // CR-03: Write usage audit record (outside transaction, eventual consistency acceptable)
      const phoneNumberHash = crypto
        .createHash("sha256")
        .update(phoneNumber)
        .digest("hex");
      await firestore
        .collection("app_credits")
        .doc(appId)
        .collection("usage")
        .add({
          deducted_at: admin.firestore.FieldValue.serverTimestamp(),
          session_id: sessionId,
          phone_number_hash: phoneNumberHash,
        });

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);

      return res.status(200).json({
        sessionId,
        expiresAt: otpExpiresAt,
      });
    } catch (error) {
      logger.error("sendOtp error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to send OTP",
      });
    }
  },
);

/**
 * POST /v4/verifyOtp
 *
 * Verifies an OTP code for a session.
 */
exports.verifyOtp = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { appId, sessionId, otp } = req.body;

    if (!appId || !sessionId || otp === undefined || otp === null) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
        message: "appId, sessionId, and otp are required",
      });
    }

    if (!String(otp).match(/^\d{6}$/)) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
        message: "OTP must be 6 digits",
      });
    }

    try {
      const db = admin.database();

      const resolvedSession = await resolveOtpSessionRecord(
        db,
        sessionId,
        appId,
      );
      if (!resolvedSession) {
        const receiptMatch = await consumeOtpVerifyReceipt(
          db,
          sessionId,
          appId,
          String(otp),
        );
        if (receiptMatch) {
          const processingTime = Date.now() - startTime;
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${processingTime}`);
          return res.status(200).json({
            verified: true,
            phoneNumber: receiptMatch.phoneNumber,
          });
        }
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(404).json({
          verified: false,
          reason: "not_found",
        });
      }

      const { sessionPath, sessionKey, sessionRef } = resolvedSession;
      let { session } = resolvedSession;

      if (session.appId !== appId) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          verified: false,
          reason: "app_mismatch",
        });
      }

      if (session.locked === true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(423).json({
          verified: false,
          reason: "locked",
        });
      }

      if (Date.now() > session.expiresAt) {
        // Do NOT delete the session here — the scheduled cleanup job handles
        // expired record removal.  Eager deletion here created a race window
        // where a legitimate verify call racing expiry would get 404 instead
        // of the correct 410.
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(410).json({
          verified: false,
          reason: "expired",
        });
      }

      // Atomically increment attempts on the whole session document so we
      // never observe a phantom 404.  The old two-step approach (transaction
      // on the child path + a separate once("value") read) had a race window:
      // if anything deleted the session between those two calls the subsequent
      // read returned null and we incorrectly returned 404.  Using a single
      // parent-level transaction eliminates that window — if the session is
      // gone when the transaction fires, we abort (return undefined) and the
      // committed flag is false, giving us a clean not_found without a
      // separate read.
      //
      // HOWEVER: Firebase RTDB transactions exhibit a "null-start" behaviour on
      // Cloud Functions cold-starts.  The SDK calls the callback with null on
      // the first invocation because it has no locally-cached value yet —
      // returning undefined aborts the transaction spuriously even though the
      // node exists on the server.  We guard against this by re-reading the
      // node when committed=false: if it still exists the abort was a null-start
      // false-positive, so we fall back to a direct increment; if it is gone
      // the session was genuinely deleted.
      const { committed, snapshot: updatedSnapshot } =
        await sessionRef.transaction((currentSession) => {
          if (currentSession === null) {
            return undefined; // abort — may be null-start or genuine removal
          }
          return {
            ...currentSession,
            attempts: (currentSession.attempts || 0) + 1,
          };
        });

      if (!committed) {
        // Disambiguate null-start abort from genuine concurrent deletion.
        const recheckSnap = await sessionRef.once("value");
        if (!recheckSnap.exists()) {
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          return res.status(404).json({
            verified: false,
            reason: "not_found",
          });
        }
        // Null-start confirmed — session is still there.  Increment directly.
        session = recheckSnap.val();
        const newAttempts = (session.attempts || 0) + 1;
        await sessionRef.child("attempts").set(newAttempts);
        session = { ...session, attempts: newAttempts };
      } else if (!updatedSnapshot || !updatedSnapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(404).json({
          verified: false,
          reason: "not_found",
        });
      } else {
        session = updatedSnapshot.val();
      }

      const attempts = session.attempts;

      if (attempts >= 3) {
        await sessionRef.child("locked").set(true);
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(423).json({
          verified: false,
          reason: "locked",
        });
      }

      const computedHash = generateHmac(
        VERIFICATION_SIGNING_SECRET,
        `${sessionKey}${otp}`,
      );

      if (!timingSafeEqual(computedHash, session.hashedOtp)) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          verified: false,
          reason: "mismatch",
        });
      }

      const verificationReceipt = {
        appId,
        expiresAt: session.expiresAt,
        hashedOtp: session.hashedOtp,
        phoneNumber: session.phoneNumber,
        replayAvailable: true,
        verifiedAt: admin.database.ServerValue.TIMESTAMP,
      };
      const updates = {};
      updates[`${sessionPath}/${sessionKey}`] = null;
      updates[`pending_sms/${sessionKey}`] = null;
      updates[`otp_verify_receipts/${sessionKey}`] = verificationReceipt;
      await db.ref().update(updates);

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);

      return res.status(200).json({
        verified: true,
        phoneNumber: session.phoneNumber,
      });
    } catch (error) {
      logger.error("verifyOtp error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        verified: false,
        error: "integrity_error",
        message: "Failed to verify OTP",
      });
    }
  },
);

/**
 * POST /v4/otpStatus
 *
 * Checks the delivery status of an OTP and optionally resends on failure.
 * WH-03: Calls sendWebhook when status transitions to sent/failed/expired.
 */
exports.otpStatus = onRequest(
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

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { appId, sessionId, resend } = req.body;

    if (!appId || !sessionId) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        error: "bad_request",
        message: "appId and sessionId are required",
      });
    }

    try {
      const db = admin.database();

      // Kill switch: block resend attempts while SMS sending is paused.
      const pausedSnap = await db.ref("config/sms_paused").once("value");
      if (pausedSnap.val() === true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(503).json({
          error: "service_paused",
          message: "SMS sending is temporarily paused. Please try again later.",
        });
      }

      const otpSnapshot = await db
        .ref(`otp_requests/${sessionId}`)
        .once("value");

      if (!otpSnapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);

        // WH-03: Fire webhook for expired/not_found
        fireWebhook(sessionId, "expired");

        return res.status(200).json({
          status: "not_found",
        });
      }

      const otpSession = otpSnapshot.val();

      // Guard: Authenticator app has already confirmed this SMS was delivered.
      // The onSmsCompleted RTDB trigger stamps sent_at on the otp_requests node
      // the moment the Android device deletes /pending_sms/{sessionId} on success.
      // Once confirmed, NO further resend is ever allowed for this session.
      if (otpSession.sent_at) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          status: "sent",
          sent_at: otpSession.sent_at,
          message: "OTP was already confirmed delivered to this number.",
        });
      }

      if (otpSession.appId !== appId) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          error: "app_mismatch",
        });
      }

      // Check expiry
      if (Date.now() > otpSession.expiresAt) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);

        // WH-03: Fire webhook for expired
        fireWebhook(sessionId, "expired");

        return res.status(200).json({
          status: "expired",
        });
      }

      // Check locked
      if (otpSession.locked === true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);

        // WH-03: Fire webhook for failed
        fireWebhook(sessionId, "failed", {
          reason: "Session locked due to too many attempts",
        });

        return res.status(200).json({
          status: "failed",
          error: "Session locked due to too many attempts",
        });
      }

      // Read /pending_sms/{sessionId}
      const pendingSnapshot = await db
        .ref(`pending_sms/${sessionId}`)
        .once("value");

      if (!pendingSnapshot.exists()) {
        // SMS was sent (deleted by device)
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);

        // WH-03: Fire webhook for sent
        fireWebhook(sessionId, "sent");

        return res.status(200).json({
          status: "sent",
        });
      }

      const pendingData = pendingSnapshot.val();

      // Check if there's an error
      if (pendingData.error) {
        // WH-03: Fire webhook for failed before potential resend
        fireWebhook(sessionId, "failed", { error: pendingData.error });

        if (resend === true) {
          // ── Guard 1: max resend attempts ─────────────────────────────────
          // Limits how many times a single session can be retried.
          // Prevents an SDK polling loop from triggering infinite sends.
          const MAX_RESENDS = 2;
          const currentResendCount = otpSession.resend_count || 0;
          if (currentResendCount >= MAX_RESENDS) {
            res.setHeader("X-Request-ID", requestId);
            res.setHeader(
              "Server-Timing",
              `total;dur=${Date.now() - startTime}`,
            );
            return res.status(429).json({
              status: "failed",
              error: "max_resends_exceeded",
              message: `Maximum of ${MAX_RESENDS} resend attempts reached for this session.`,
            });
          }

          // ── Guard 2: per-phone RTDB cooldown ─────────────────────────────
          // Checks the same shared cooldown node used by sendOtp.
          // Protects against a rapid failure-resend-failure loop hammering
          // the same number.  Cooldown is NOT reset here because a failed
          // send means the phone hasn't actually received anything yet —
          // we still want to allow the retry, just not within the window.
          const phoneCooldownHashResend = crypto
            .createHash("sha256")
            .update(otpSession.phoneNumber)
            .digest("hex")
            .substring(0, 32);
          const cooldownSnapResend = await db
            .ref(`otp_cooldown/${phoneCooldownHashResend}`)
            .once("value");
          if (cooldownSnapResend.exists()) {
            const cd = cooldownSnapResend.val();
            if (cd && cd.expiresAt > Date.now()) {
              const waitSecs = Math.ceil((cd.expiresAt - Date.now()) / 1000);
              res.setHeader("X-Request-ID", requestId);
              res.setHeader(
                "Server-Timing",
                `total;dur=${Date.now() - startTime}`,
              );
              res.setHeader("Retry-After", waitSecs.toString());
              return res.status(429).json({
                status: "failed",
                error: "cooldown",
                message: `Please wait ${waitSecs}s before resending to this number.`,
                waitSeconds: waitSecs,
              });
            }
          }

          const appSnapshot = await db
            .ref(`registered_apps/${appId}`)
            .once("value");
          const appData = appSnapshot.val();

          // Regenerate OTP
          const newOtp = crypto.randomInt(100000, 999999);
          const newHashedOtp = generateHmac(
            VERIFICATION_SIGNING_SECRET,
            `${sessionId}${newOtp}`,
          );

          const ttlMs = 10 * 60 * 1000;
          const newExpiresAt = Date.now() + ttlMs;
          const ttlMinutes = Math.floor(ttlMs / 60000);

          // Increment resend_count so we can enforce MAX_RESENDS.
          await db.ref(`otp_requests/${sessionId}`).update({
            hashedOtp: newHashedOtp,
            expiresAt: newExpiresAt,
            attempts: 0,
            locked: false,
            resend_count: currentResendCount + 1,
          });

          // Re-arm the per-phone cooldown for 30 s from this resend attempt.
          await db.ref(`otp_cooldown/${phoneCooldownHashResend}`).set({
            expiresAt: Date.now() + 30000,
            appId,
            source: "resend",
          });

          const smsTemplate =
            appData?.smsTemplate ||
            "Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.";
          const message = smsTemplate
            .replace("{appName}", appData?.name || "Service")
            .replace("{otp}", newOtp.toString())
            .replace("{ttl}", ttlMinutes.toString());

          const resendPendingData = {
            appId,
            to: otpSession.phoneNumber,
            message,
            status: "pending",
            createdAt: admin.database.ServerValue.TIMESTAMP,
          };

          // WH-01: Preserve webhook data on resend
          if (appData?.webhookUrl) {
            resendPendingData.webhookUrl = appData.webhookUrl;
          }
          if (appData?.webhookSecretHash) {
            resendPendingData.webhookSecretHash = appData.webhookSecretHash;
          }

          await db.ref(`pending_sms/${sessionId}`).set(resendPendingData);

          const processingTime = Date.now() - startTime;
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${processingTime}`);

          return res.status(200).json({
            status: "pending",
            sessionId,
            expiresAt: newExpiresAt,
          });
        }

        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          status: "failed",
          error: pendingData.error || "SMS send failed",
        });
      }

      // Still pending
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(200).json({
        status: "pending",
      });
    } catch (error) {
      logger.error("otpStatus error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to check OTP status",
      });
    }
  },
);

// ============================================================
// PHASE 8: Billing Functions (re-exported from modules)
// ============================================================

/**
 * POST /getCredits — re-exported from module.
 * Returns the current credit balance for an authenticated app.
 */
const { getCredits: _getCredits } = require("./src/billing/getCredits");
exports.getCredits = _getCredits;

/**
 * Callable /upsertPackage — re-exported from module.
 * Admin creates or updates a credit package.
 */
const {
  upsertPackage: _upsertPackage,
} = require("./src/billing/upsertPackage");
exports.upsertPackage = _upsertPackage;

/**
 * POST /requestCredit — re-exported from module.
 * Client initiates a credit purchase request.
 */
const {
  requestCredit: _requestCredit,
} = require("./src/billing/requestCredit");
exports.requestCredit = _requestCredit;

/**
 * POST /submitTrxId — re-exported from module.
 * Client attaches a bKash TrxID to a pending transaction.
 */
const { submitTrxId: _submitTrxId } = require("./src/billing/submitTrxId");
exports.submitTrxId = _submitTrxId;

/**
 * createBulkCampaign — new bulk SMS campaign creation.
 */
const {
  createBulkCampaign: _createBulkCampaign,
} = require("./src/bulk/createBulkCampaign");
exports.createBulkCampaign = _createBulkCampaign;

/**
 * onSmsCompleted — RTDB trigger for bulk pending_sms deletion.
 */
const {
  onSmsCompleted: _onSmsCompleted,
} = require("./src/bulk/onSmsCompleted");
exports.onSmsCompleted = _onSmsCompleted;

/**
 * processBulkQueue — scheduled bulk enqueue and retry handling.
 */
const {
  processBulkQueue: _processBulkQueue,
} = require("./src/bulk/processBulkQueue");
exports.processBulkQueue = _processBulkQueue;

/**
 * finalizeCompletedCampaigns — scheduled bulk completion and webhook finalization.
 */
const {
  finalizeCompletedCampaigns: _finalizeCompletedCampaigns,
} = require("./src/bulk/finalizeCompletedCampaigns");
exports.finalizeCompletedCampaigns = _finalizeCompletedCampaigns;

/**
 * Callable /getCampaignStatus — reads campaign + progress for UI.
 */
const {
  getCampaignStatus: _getCampaignStatus,
} = require("./src/bulk/getCampaignStatus");
exports.getCampaignStatus = _getCampaignStatus;

/**
 * Callable /listCampaigns — paginated campaign list for UI.
 */
const { listCampaigns: _listCampaigns } = require("./src/bulk/listCampaigns");
exports.listCampaigns = _listCampaigns;

/**
 * Callable /listApps — list registered apps for the current user or admin.
 */
const { listApps: _listApps } = require("./src/apps/listApps");
exports.listApps = _listApps;

/**
 * Callable /listPackages — list available credit packages for admin.
 */
const { listPackages: _listPackages } = require("./src/billing/listPackages");
exports.listPackages = _listPackages;

/**
 * Callable /getTransactions — list credit purchase transactions for users and admins.
 */
const {
  getTransactions: _getTransactions,
} = require("./src/billing/getTransactions");
exports.getTransactions = _getTransactions;

/**
 * Callable /getInvoiceHistory — aggregated invoice history per app and date range.
 */
const {
  getInvoiceHistory: _getInvoiceHistory,
} = require("./src/billing/getInvoiceHistory");
exports.getInvoiceHistory = _getInvoiceHistory;

/**
 * Callable /listFailedRecipients — list failed recipients for a bulk campaign.
 */
const {
  listFailedRecipients: _listFailedRecipients,
} = require("./src/bulk/listFailedRecipients");
exports.listFailedRecipients = _listFailedRecipients;

/**
 * Callable /pauseCampaign — pause an active bulk campaign.
 */
const { pauseCampaign: _pauseCampaign } = require("./src/bulk/pauseCampaign");
exports.pauseCampaign = _pauseCampaign;

/**
 * Callable /resumeCampaign — resume a paused bulk campaign.
 */
const {
  resumeCampaign: _resumeCampaign,
} = require("./src/bulk/resumeCampaign");
exports.resumeCampaign = _resumeCampaign;

/**
 * Callable /cancelCampaign — cancel a bulk campaign and refund credits.
 */
const {
  cancelCampaign: _cancelCampaign,
} = require("./src/bulk/cancelCampaign");
exports.cancelCampaign = _cancelCampaign;

/**
 * Callable /retryFailedJobs — re-queue failed bulk recipients.
 */
const {
  retryFailedJobs: _retryFailedJobs,
} = require("./src/bulk/retryFailedJobs");
exports.retryFailedJobs = _retryFailedJobs;

/**
 * Callable /approveCredit — re-exported from module.
 * Admin approves or rejects a credit transaction.
 */
const {
  approveCredit: _approveCredit,
} = require("./src/billing/approveCredit");
exports.approveCredit = _approveCredit;

// ============================================================
// PHASE 2: Scheduled Stats Aggregation (re-exported from module)
// ============================================================

const {
  aggregateStats: _aggregateStats,
} = require("./src/jobs/aggregateStats");
exports.aggregateStats = _aggregateStats;

// ============================================================
// PHASE: Bulk SMS External API (HTTPS endpoints, appId auth)
// ============================================================

/**
 * POST /sendBulkSms — external bulk SMS API.
 * Authenticates via appId + appSecret (no Firebase Auth needed).
 */
const { sendBulkSms: _sendBulkSms } = require("./src/bulk/sendBulkSms");
exports.sendBulkSms = _sendBulkSms;

/**
 * POST /getBulkStatus — check bulk campaign status.
 * Authenticates via appId + appSecret.
 */
const { getBulkStatus: _getBulkStatus } = require("./src/bulk/getBulkStatus");
exports.getBulkStatus = _getBulkStatus;

// ============================================================
// Phase 9: Bulk SMS Enhancements (Callable functions)
// ============================================================

/**
 * Callable /createContactGroup — create a contact group with phone numbers.
 */
exports.createContactGroup = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const { name, phones } = request.data || {};
    const uid = request.auth.uid;

    if (!name || name.trim() === "") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Group name is required",
      );
    }
    if (name.length > 100) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Group name must be less than 100 characters",
      );
    }
    if (!Array.isArray(phones) || phones.length === 0) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "At least one phone number is required",
      );
    }
    if (phones.length > 10000) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Maximum 10,000 phone numbers allowed",
      );
    }

    // Validate and deduplicate phones
    const uniquePhones = new Set();
    for (const phone of phones) {
      const trimmed = String(phone).trim();
      if (!trimmed.match(/^\+[0-9]{7,15}$/)) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          `Invalid phone number format: ${phone}`,
        );
      }
      uniquePhones.add(trimmed);
    }

    const validPhones = Array.from(uniquePhones);
    if (validPhones.length === 0) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "No valid phone numbers provided",
      );
    }

    // Check 50-group limit
    const groupsSnapshot = await firestore
      .collection("contactGroups")
      .where("uid", "==", uid)
      .limit(50)
      .get();

    if (groupsSnapshot.docs.length >= 50) {
      throw new admin.functions.https.HttpsError(
        "resource-exhausted",
        "You have reached the maximum of 50 contact groups",
      );
    }

    // Create group document
    const groupId = firestore.collection("contactGroups").doc().id;
    const groupRef = firestore.collection("contactGroups").doc(groupId);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await groupRef.set({
      uid,
      name: name.trim(),
      phoneCount: validPhones.length,
      createdAt: now,
      updatedAt: now,
    });

    // Batch-write phone documents (using phone as doc ID for uniqueness)
    const phonesRef = groupRef.collection("phones");
    const phoneBatches = [];
    let currentBatch = firestore.batch();
    let opCount = 0;

    for (const phone of validPhones) {
      currentBatch.set(phonesRef.doc(phone), { phone });
      opCount++;
      if (opCount >= 500) {
        phoneBatches.push(currentBatch.commit());
        currentBatch = firestore.batch();
        opCount = 0;
      }
    }
    if (opCount > 0) {
      phoneBatches.push(currentBatch.commit());
    }
    await Promise.all(phoneBatches);

    return { groupId, phoneCount: validPhones.length, name: name.trim() };
  },
);

/**
 * Callable /listContactGroups — list contact groups for the current user.
 */
exports.listContactGroups = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const snapshot = await firestore
      .collection("contactGroups")
      .where("uid", "==", request.auth.uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const groups = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        groupId: doc.id,
        name: d.name,
        phoneCount: d.phoneCount,
        createdAt: d.createdAt.toDate().toISOString(),
      };
    });

    return { groups };
  },
);

/**
 * Callable /deleteContactGroup — delete a contact group and all its phones.
 */
exports.deleteContactGroup = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const { groupId } = request.data || {};
    if (!groupId || typeof groupId !== "string") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Group ID is required",
      );
    }

    const groupRef = firestore.collection("contactGroups").doc(groupId);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      throw new admin.functions.https.HttpsError(
        "not-found",
        "Contact group not found",
      );
    }
    if (groupDoc.data().uid !== request.auth.uid) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to delete this group",
      );
    }

    // Delete phone sub-collection and parent
    const phonesSnapshot = await groupRef.collection("phones").get();
    const batch = firestore.batch();
    phonesSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
    batch.delete(groupRef);
    await batch.commit();

    return { deleted: true };
  },
);

/**
 * Callable /listContactGroupPhones — paginated phone list for a contact group.
 */
exports.listContactGroupPhones = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const { groupId, pageSize = 100, pageToken } = request.data || {};
    if (!groupId || typeof groupId !== "string") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Group ID is required",
      );
    }

    const groupDoc = await firestore
      .collection("contactGroups")
      .doc(groupId)
      .get();
    if (!groupDoc.exists) {
      throw new admin.functions.https.HttpsError(
        "not-found",
        "Contact group not found",
      );
    }
    if (groupDoc.data().uid !== request.auth.uid) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to view this group",
      );
    }

    const limit = Math.min(pageSize || 100, 500);
    let query = firestore
      .collection("contactGroups")
      .doc(groupId)
      .collection("phones")
      .orderBy("phone")
      .limit(limit);

    if (pageToken) {
      query = query.startAfter(pageToken);
    }

    const snapshot = await query.get();
    const phones = snapshot.docs.map((doc) => doc.data().phone);
    const nextPageToken =
      snapshot.docs.length === limit
        ? snapshot.docs[snapshot.docs.length - 1].id
        : null;

    return { phones, nextPageToken };
  },
);

/**
 * Callable /createMessageTemplate — create a new message template.
 */
exports.createMessageTemplate = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const { name, body } = request.data || {};
    if (!name || name.trim() === "") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Template name is required",
      );
    }
    if (name.length > 100) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Template name must be less than 100 characters",
      );
    }
    if (!body || typeof body !== "string" || body.trim() === "") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Template body is required",
      );
    }
    if (body.length > 1600) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Template body must be less than 1600 characters",
      );
    }

    // Check 100-template limit
    const templatesSnapshot = await firestore
      .collection("messageTemplates")
      .where("uid", "==", request.auth.uid)
      .limit(100)
      .get();

    if (templatesSnapshot.docs.length >= 100) {
      throw new admin.functions.https.HttpsError(
        "resource-exhausted",
        "You have reached the maximum of 100 message templates",
      );
    }

    const templateId = firestore.collection("messageTemplates").doc().id;
    const now = admin.firestore.FieldValue.serverTimestamp();

    await firestore.collection("messageTemplates").doc(templateId).set({
      uid: request.auth.uid,
      name: name.trim(),
      body: body.trim(),
      createdAt: now,
      updatedAt: now,
    });

    return { templateId, name: name.trim(), body: body.trim() };
  },
);

/**
 * Callable /listMessageTemplates — list message templates for the current user.
 */
exports.listMessageTemplates = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const snapshot = await firestore
      .collection("messageTemplates")
      .where("uid", "==", request.auth.uid)
      .orderBy("updatedAt", "desc")
      .limit(100)
      .get();

    const templates = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        templateId: doc.id,
        name: d.name,
        body: d.body,
        createdAt: d.createdAt.toDate().toISOString(),
        updatedAt: d.updatedAt.toDate().toISOString(),
      };
    });

    return { templates };
  },
);

/**
 * Callable /updateMessageTemplate — update an existing message template.
 */
exports.updateMessageTemplate = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const { templateId, name, body } = request.data || {};
    if (!templateId || typeof templateId !== "string") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Template ID is required",
      );
    }
    if (!name && !body) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "At least one field (name or body) must be provided",
      );
    }

    const templateRef = firestore
      .collection("messageTemplates")
      .doc(templateId);
    const templateDoc = await templateRef.get();

    if (!templateDoc.exists) {
      throw new admin.functions.https.HttpsError(
        "not-found",
        "Message template not found",
      );
    }
    if (templateDoc.data().uid !== request.auth.uid) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to update this template",
      );
    }

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (name) {
      if (name.length > 100) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "Template name must be less than 100 characters",
        );
      }
      updateData.name = name.trim();
    }
    if (body) {
      if (body.length > 1600) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "Template body must be less than 1600 characters",
        );
      }
      updateData.body = body.trim();
    }

    await templateRef.update(updateData);
    return { updated: true };
  },
);

/**
 * Callable /deleteMessageTemplate — delete a message template.
 */
exports.deleteMessageTemplate = onCall(
  { cors: true, region: "asia-southeast1" },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    const { templateId } = request.data || {};
    if (!templateId || typeof templateId !== "string") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "Template ID is required",
      );
    }

    const templateRef = firestore
      .collection("messageTemplates")
      .doc(templateId);
    const templateDoc = await templateRef.get();

    if (!templateDoc.exists) {
      throw new admin.functions.https.HttpsError(
        "not-found",
        "Message template not found",
      );
    }
    if (templateDoc.data().uid !== request.auth.uid) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to delete this template",
      );
    }

    await templateRef.delete();
    return { deleted: true };
  },
);

// ============================================================
// Utility exports for testing
// ============================================================
exports.generateHmac = generateHmac;
exports.generateSessionCode = generateSessionCode;
exports.timingSafeEqual = timingSafeEqual;
exports.isWithinClockSkew = isWithinClockSkew;
exports.isRateLimited = isRateLimited;
exports.validateAppCredentials = validateAppCredentials;
