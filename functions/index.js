// Deploy v4.0.2 - number update
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const crypto = require("crypto");

const serviceAccount = require("./authenticator-15fb7-36cfda9edf3b.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://authenticator-15fb7-default-rtdb.asia-southeast1.firebasedatabase.app",
});

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
// Build: v4.0.2 (dedicated number update)

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
 * Generates HMAC-SHA256 signature.
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
 * POST /v4/startVerification
 *
 * Initiates a phone number verification.
 *
 * Request body:
 * {
 *   "phoneNumber": "+8801712345678",
 *   "clientTimestamp": 1234567890
 * }
 *
 * Response:
 * {
 *   "sessionCode": "A3F1B9C2E4",
 *   "smsBody": "AUTH:A3F1B9C2E4:1234567890:XYZ123",
 *   "dedicatedNumber": "+8801712345678",
 *   "expiresAt": 1234567890,
 *   "pollToken": "base64_encoded_token"
 * }
 *
 * Rate limit: 10 requests per 15 minutes per IP
 */
exports.startVerification = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const ip = req.ip || req.connection.remoteAddress;
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Rate limiting
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

    // Validation
    if (!phoneNumber || !clientTimestamp) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    // Validate phone number format (E.164)
    if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    // Validate clock skew
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

      // Generate SMS body
      const smsBody = `AUTH:${sessionCode}:${expiresAt}:${challengeToken}`;

      // Generate poll token (HMAC of POLL:{sessionCode}:{userPhone}:{expiresAt})
      const pollToken = generateHmac(
        VERIFICATION_SIGNING_SECRET,
        `POLL:${sessionCode}:${phoneNumber}:${expiresAt}`,
      );

      // Write to RTDB with userPhone field
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
      console.error("startVerification error:", error);
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
 *
 * Request body:
 * {
 *   "sessionCode": "A3F1B9C2E4",
 *   "pollToken": "base64_encoded_token"
 * }
 *
 * Response:
 * {
 *   "status": "verified",
 *   "sender": "+8801712345678"
 * }
 *
 * Rate limit: 30 requests per minute per IP
 * On successful verification: atomic delete of the request
 */
exports.checkAuth = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const ip = req.ip || req.connection.remoteAddress;
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Rate limiting
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

    // Validation
    if (!sessionCode || !pollToken) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    // Session code format validation (10 uppercase hex characters)
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

      // Check expiry
      if (Date.now() > data.expiresAt) {
        // Delete expired request
        await db.ref(`verification_requests/${sessionCode}`).remove();
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          verified: false,
          reason: "expired",
          sessionCode,
        });
      }

      // Verify poll token using constant-time comparison (POLL:{sessionCode}:{userPhone}:{expiresAt})
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

      // Check if receipt exists
      if (data.receipt) {
        const { sender, challengeToken } = data.receipt;

        // Verify challenge token using constant-time comparison
        if (!timingSafeEqual(challengeToken, data.challengeToken)) {
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          return res.status(403).json({
            verified: false,
            error: "invalid_challenge",
          });
        }

        // Verify sender equality (receipt.sender == userPhone)
        // Use constant-time comparison to prevent timing attacks
        if (!timingSafeEqual(sender, userPhone)) {
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
          return res.status(200).json({
            verified: false,
            reason: "mismatch",
            sessionCode,
          });
        }

        // Atomic delete on successful verification
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

      // Pending
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
      console.error("checkAuth error:", error);
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
 *
 * Request headers:
 * Authorization: Bearer <AUTHENTICATOR_ENROLLMENT_SECRET>
 *
 * Request body:
 * {
 *   "androidId": "abc123",
 *   "model": "Pixel 6"
 * }
 *
 * Response:
 * {
 *   "firebaseCustomToken": "custom_token_here"
 * }
 */
exports.registerAuthenticator = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
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

    // Constant-time comparison of enrollment secret
    if (!timingSafeEqual(providedSecret, AUTHENTICATOR_ENROLLMENT_SECRET)) {
      return res.status(403).json({
        verified: false,
        error: "unauthorized_device",
      });
    }

    const { androidId, model } = req.body;

    // Validation
    if (!androidId || !model) {
      return res.status(400).json({
        verified: false,
        error: "bad_request",
      });
    }

    try {
      // Create custom token with role=authenticator claim
      const customToken = await admin.auth().createCustomToken(androidId, {
        role: "authenticator",
        model,
      });

      return res.status(200).json({
        firebaseCustomToken: customToken,
      });
    } catch (error) {
      console.error("registerAuthenticator error:", error);
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
 *
 * Request headers:
 * Authorization: Bearer <HEALTH_ADMIN_SECRET>
 *
 * Response:
 * {
 *   "status": "healthy",
 *   "timestamp": 1234567890,
 *   "activeDevices": 1,
 *   "queueDepth": 5
 * }
 *
 * Returns healthy only when activeDevices >= 1 && queueDepth <= 100
 */
exports.health = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
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

    // Constant-time comparison
    if (!timingSafeEqual(providedSecret, HEALTH_ADMIN_SECRET)) {
      return res.status(403).json({
        verified: false,
        error: "unauthorized_device",
      });
    }

    try {
      const db = admin.database();

      // Count active devices (health entries with lastPing within 5 minutes)
      const now = Date.now();
      const activeCutoff = now - 5 * 60 * 1000; // 5 minutes

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

      // Count queue depth (verification_requests without receipt)
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

      // Health condition: activeDevices >= 1 && queueDepth <= 100
      const isHealthy = activeDevices >= 1 && queueDepth <= 100;

      return res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? "healthy" : "unhealthy",
        timestamp: now,
        activeDevices,
        queueDepth,
      });
    } catch (error) {
      console.error("health error:", error);
      return res.status(500).json({
        verified: false,
        error: "integrity_error",
      });
    }
  },
);

/**
 * Scheduled function to clean up old verification requests and expired OTP requests.
 * Runs daily at midnight.
 *
 * Uses orderByChild('createdAt').endAt(cutoff) for efficient querying
 * instead of reading the entire tree.
 */
exports.cleanupOldRequests = onSchedule(
  {
    schedule: "0 0 * * *",
    region: "asia-southeast1",
    timeZone: "Asia/Dhaka",
  },
  async (event) => {
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
          console.log(`Cleaned up ${Object.keys(updates).length} old verification requests`);
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
          console.log(`Cleaned up ${Object.keys(otpUpdates).length} expired OTP requests`);
        }
      }
    } catch (error) {
      console.error("cleanupOldRequests error:", error);
    }
  },
);

/**
 * POST /v4/registerApp
 *
 * Registers a new app in the multi-tenant app registry.
 * Gated by APP_MASTER_SECRET - root of trust for the entire registry.
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
 *
 * Note: appSecret is shown ONLY ONCE. Save it immediately.
 * apiKeyHash (HMAC of appId+appSecret) is stored in RTDB, not the raw secret.
 */
exports.registerApp = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "method_not_allowed",
      });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { masterSecret, appName, smsTemplate, rateLimit } = req.body;

    // Validate masterSecret using constant-time comparison
    if (!masterSecret || !timingSafeEqual(masterSecret, APP_MASTER_SECRET || "")) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid master secret",
      });
    }

    // Validate appName
    if (!appName || typeof appName !== "string" || appName.trim().length === 0) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        error: "bad_request",
        message: "appName is required and must be a non-empty string",
      });
    }

    try {
      const db = admin.database();

      // Generate appId (UUID v4) and appSecret (32 bytes)
      const appId = crypto.randomUUID();
      const appSecret = crypto.randomBytes(32).toString("base64");

      // Compute apiKeyHash = HMAC(APP_MASTER_SECRET, appId + appSecret)
      // This hash is stored in RTDB, never the raw appSecret
      const apiKeyHash = generateHmac(APP_MASTER_SECRET, `${appId}${appSecret}`);

      // Default SMS template if not provided
      const finalSmsTemplate = smsTemplate && smsTemplate.trim().length > 0
        ? smsTemplate.trim()
        : "Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.";

      // Default rate limit if not provided
      const finalRateLimit = rateLimit && typeof rateLimit === "object"
        ? {
            maxPerPhone: Number(rateLimit.maxPerPhone) || 3,
            windowMs: Number(rateLimit.windowMs) || 600000,
          }
        : { maxPerPhone: 3, windowMs: 600000 };

      // Store app registration in RTDB
      const appData = {
        name: appName.trim(),
        apiKeyHash,
        smsTemplate: finalSmsTemplate,
        rateLimit: finalRateLimit,
        active: true,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      };

      await db.ref(`registered_apps/${appId}`).set(appData);

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);

      // Return appId and appSecret - appSecret shown ONCE only
      return res.status(200).json({
        appId,
        appSecret,
        message: "Save appSecret immediately - it will not be shown again",
      });
    } catch (error) {
      console.error("registerApp error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to register app",
      });
    }
  },
);

/**
 * POST /v4/revokeApp
 *
 * Revokes (soft deletes) an app from the registry.
 * Gated by APP_MASTER_SECRET.
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
 *
 * Note: This is a soft delete - preserves audit trail.
 * Does NOT delete /otp_requests or /pending_sms in flight - those expire naturally.
 */
exports.revokeApp = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "method_not_allowed",
      });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { masterSecret, appId } = req.body;

    // Validate masterSecret using constant-time comparison
    if (!masterSecret || !timingSafeEqual(masterSecret, APP_MASTER_SECRET || "")) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid master secret",
      });
    }

    // Validate appId
    if (!appId || typeof appId !== "string" || appId.trim().length === 0) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        error: "bad_request",
        message: "appId is required",
      });
    }

    try {
      const db = admin.database();

      // Check if app exists
      const snapshot = await db.ref(`registered_apps/${appId}`).once("value");

      if (!snapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(404).json({
          error: "not_found",
          message: "App not found",
        });
      }

      // Soft delete: set active = false
      await db.ref(`registered_apps/${appId}/active`).set(false);

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);

      return res.status(200).json({
        appId,
        active: false,
        message: "App revoked successfully",
      });
    } catch (error) {
      console.error("revokeApp error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to revoke app",
      });
    }
  },
);

/**
 * POST /v4/sendOtp
 *
 * Initiates an OTP verification by sending an SMS to the user's phone.
 * Multi-tenant: each app must identify itself with appId + appSecret.
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
 *
 * Rate limit: per-app, per-phone (read from /registered_apps/{appId}/rateLimit)
 * NEVER returns the OTP or the rendered SMS message to the caller.
 */
exports.sendOtp = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
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
        message: "Invalid phone number format. Use E.164 format (e.g., +8801712345678)",
      });
    }

    try {
      const db = admin.database();

      // Step 1: Read /registered_apps/{appId}
      const appSnapshot = await db.ref(`registered_apps/${appId}`).once("value");

      if (!appSnapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          error: "app_not_found",
          message: "App not found or invalid appId",
        });
      }

      const appData = appSnapshot.val();

      // Check if app is active
      if (appData.active !== true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          error: "app_revoked",
          message: "App has been revoked",
        });
      }

      // Step 2: Validate appSecret using timingSafeEqual
      const expectedApiKeyHash = generateHmac(APP_MASTER_SECRET, `${appId}${appSecret}`);
      if (!timingSafeEqual(expectedApiKeyHash, appData.apiKeyHash)) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          error: "invalid_credentials",
          message: "Invalid appSecret",
        });
      }

      // Step 3: Read rateLimit from app config (fallback to defaults)
      const rateLimit = appData.rateLimit || { maxPerPhone: 3, windowMs: 600000 };
      const maxPerPhone = rateLimit.maxPerPhone || 3;
      const windowMs = rateLimit.windowMs || 600000;

      // Step 4: Enforce per-phone, per-app rate limit
      const rateLimitKey = `${appId}+${phoneNumber}`;
      const rateLimitResult = isRateLimited(rateLimitKey, maxPerPhone, windowMs);

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

      // Step 5: Generate 6-digit OTP
      const otp = crypto.randomInt(100000, 999999);

      // Generate session ID
      const sessionId = crypto.randomUUID();

      // Step 6: Compute hashedOtp = HMAC(VERIFICATION_SIGNING_SECRET, sessionId+otp)
      const hashedOtp = generateHmac(VERIFICATION_SIGNING_SECRET, `${sessionId}${otp}`);

      // Step 7: Compute expiresAt (default 10 minutes)
      const ttlMs = 10 * 60 * 1000; // 10 minutes default
      const expiresAt = Date.now() + ttlMs;
      const ttlMinutes = Math.floor(ttlMs / 60000);

      // Step 8: Write /otp_requests/{sessionId}
      await db.ref(`otp_requests/${sessionId}`).set({
        appId,
        phoneNumber,
        hashedOtp,
        createdAt: admin.database.ServerValue.TIMESTAMP,
        expiresAt,
        attempts: 0,
        locked: false,
      });

      // Step 9: Read smsTemplate and render
      const smsTemplate = appData.smsTemplate ||
        "Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.";

      const message = smsTemplate
        .replace("{appName}", appData.name)
        .replace("{otp}", otp.toString())
        .replace("{ttl}", ttlMinutes.toString());

      // Step 10: Write /pending_sms/{sessionId}
      await db.ref(`pending_sms/${sessionId}`).set({
        appId,
        to: phoneNumber,
        message,
        status: "pending",
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);

      // Return sessionId and expiresAt (NOT the OTP or message)
      return res.status(200).json({
        sessionId,
        expiresAt,
      });
    } catch (error) {
      console.error("sendOtp error:", error);
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
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "sessionId": "uuid-v4",
 *   "otp": "123456"
 * }
 *
 * Response on success:
 * {
 *   "verified": true,
 *   "phoneNumber": "+8801712345678"
 * }
 *
 * Response on failure:
 * {
 *   "verified": false,
 *   "reason": "mismatch|locked|expired|not_found|app_mismatch"
 * }
 *
 * On success, atomically deletes /otp_requests/{sessionId} and /pending_sms/{sessionId}.
 * On 3 wrong attempts, locks the session.
 */
exports.verifyOtp = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        error: "method_not_allowed",
      });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { appId, sessionId, otp } = req.body;

    // Validation
    if (!appId || !sessionId || otp === undefined || otp === null) {
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(400).json({
        verified: false,
        error: "bad_request",
        message: "appId, sessionId, and otp are required",
      });
    }

    // Validate OTP format (6 digits)
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

      // Step 1: Read /otp_requests/{sessionId}
      const snapshot = await db.ref(`otp_requests/${sessionId}`).once("value");

      if (!snapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(404).json({
          verified: false,
          reason: "not_found",
        });
      }

      const session = snapshot.val();

      // Step 2: Validate session.appId === req.appId (prevents cross-app replay)
      if (session.appId !== appId) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(403).json({
          verified: false,
          reason: "app_mismatch",
        });
      }

      // Step 3: Check locked
      if (session.locked === true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(423).json({
          verified: false,
          reason: "locked",
        });
      }

      // Step 4: Check expiry
      if (Date.now() > session.expiresAt) {
        // Delete expired session
        await db.ref(`otp_requests/${sessionId}`).remove();
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(410).json({
          verified: false,
          reason: "expired",
        });
      }

      // Step 5: Atomically increment attempts
      const attemptsRef = db.ref(`otp_requests/${sessionId}/attempts`);
      await attemptsRef.transaction((currentAttempts) => {
        return (currentAttempts || 0) + 1;
      });

      // Re-read to get updated attempts
      const updatedSnapshot = await db.ref(`otp_requests/${sessionId}`).once("value");
      const updatedSession = updatedSnapshot.val();
      const attempts = updatedSession.attempts;

      // Step 6: Check if locked (3 attempts)
      if (attempts >= 3) {
        await db.ref(`otp_requests/${sessionId}/locked`).set(true);
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(423).json({
          verified: false,
          reason: "locked",
        });
      }

      // Step 7: Compute HMAC of incoming OTP and compare with stored hashedOtp
      const computedHash = generateHmac(VERIFICATION_SIGNING_SECRET, `${sessionId}${otp}`);

      if (!timingSafeEqual(computedHash, session.hashedOtp)) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          verified: false,
          reason: "mismatch",
        });
      }

      // Step 8: On success - atomically delete both records
      const updates = {};
      updates[`otp_requests/${sessionId}`] = null;
      updates[`pending_sms/${sessionId}`] = null;
      await db.ref().update(updates);

      const processingTime = Date.now() - startTime;
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${processingTime}`);

      return res.status(200).json({
        verified: true,
        phoneNumber: session.phoneNumber,
      });
    } catch (error) {
      console.error("verifyOtp error:", error);
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
 *
 * Request body:
 * {
 *   "appId": "uuid-v4",
 *   "sessionId": "uuid-v4",
 *   "resend": false
 * }
 *
 * Response:
 * {
 *   "status": "pending|sent|failed|expired|not_found",
 *   "error": "error message if status=failed",
 *   "sessionId": "uuid-v4",        // only if status=pending after resend
 *   "expiresAt": 1234567890        // only if status=pending after resend
 * }
 *
 * If status is "failed" and resend=true, regenerates OTP and retries.
 * Applies same per-phone rate limit as sendOtp.
 */
exports.otpStatus = onRequest(
  {
    cors: true,
    region: "asia-southeast1",
  },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "method_not_allowed",
      });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    const { appId, sessionId, resend } = req.body;

    // Validation
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

      // Read /otp_requests/{sessionId}
      const otpSnapshot = await db.ref(`otp_requests/${sessionId}`).once("value");

      if (!otpSnapshot.exists()) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          status: "not_found",
        });
      }

      const otpSession = otpSnapshot.val();

      // Validate session.appId === req.appId
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
        return res.status(200).json({
          status: "expired",
        });
      }

      // Check locked
      if (otpSession.locked === true) {
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          status: "failed",
          error: "Session locked due to too many attempts",
        });
      }

      // Read /pending_sms/{sessionId}
      const pendingSnapshot = await db.ref(`pending_sms/${sessionId}`).once("value");

      if (!pendingSnapshot.exists()) {
        // SMS was sent (deleted by device)
        res.setHeader("X-Request-ID", requestId);
        res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
        return res.status(200).json({
          status: "sent",
        });
      }

      const pendingData = pendingSnapshot.val();

      // Check if there's an error
      if (pendingData.error) {
        // Failed - check if resend requested
        if (resend === true) {
          // Apply rate limit before resending
          const rateLimitKey = `${appId}+${otpSession.phoneNumber}`;
          const appSnapshot = await db.ref(`registered_apps/${appId}`).once("value");
          const appData = appSnapshot.val();
          const rateLimit = appData?.rateLimit || { maxPerPhone: 3, windowMs: 600000 };

          const rateLimitResult = isRateLimited(
            rateLimitKey,
            rateLimit.maxPerPhone || 3,
            rateLimit.windowMs || 600000
          );

          if (rateLimitResult.limited) {
            const resetSeconds = Math.ceil(
              (rateLimitResult.resetTime - Date.now()) / 1000,
            );
            res.setHeader("X-Request-ID", requestId);
            res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
            res.setHeader("Retry-After", resetSeconds.toString());
            return res.status(429).json({
              status: "failed",
              error: pendingData.error || "SMS send failed",
              message: "Rate limited. Please try again later.",
            });
          }

          // Regenerate OTP
          const newOtp = crypto.randomInt(100000, 999999);
          const newHashedOtp = generateHmac(VERIFICATION_SIGNING_SECRET, `${sessionId}${newOtp}`);

          const ttlMs = 10 * 60 * 1000; // 10 minutes
          const newExpiresAt = Date.now() + ttlMs;
          const ttlMinutes = Math.floor(ttlMs / 60000);

          // Update otp_requests
          await db.ref(`otp_requests/${sessionId}`).update({
            hashedOtp: newHashedOtp,
            expiresAt: newExpiresAt,
            attempts: 0,
            locked: false,
          });

          // Re-render message
          const smsTemplate = appData?.smsTemplate ||
            "Your {appName} code: {otp}. Valid {ttl} minutes. Do not share.";
          const message = smsTemplate
            .replace("{appName}", appData?.name || "Service")
            .replace("{otp}", newOtp.toString())
            .replace("{ttl}", ttlMinutes.toString());

          // Update pending_sms (clear error, reset status)
          await db.ref(`pending_sms/${sessionId}`).set({
            appId,
            to: otpSession.phoneNumber,
            message,
            status: "pending",
            createdAt: admin.database.ServerValue.TIMESTAMP,
          });

          const processingTime = Date.now() - startTime;
          res.setHeader("X-Request-ID", requestId);
          res.setHeader("Server-Timing", `total;dur=${processingTime}`);

          return res.status(200).json({
            status: "pending",
            sessionId,
            expiresAt: newExpiresAt,
          });
        }

        // Just report the failure
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
      console.error("otpStatus error:", error);
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startTime}`);
      return res.status(500).json({
        error: "integrity_error",
        message: "Failed to check OTP status",
      });
    }
  },
);

// Export utility functions for testing
module.exports = {
  generateHmac,
  generateSessionCode,
  timingSafeEqual,
  isWithinClockSkew,
  isRateLimited,
};
