const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

let db;
/**
 * Returns the Firestore instance, initialising it lazily on first use.
 * Lazy initialisation avoids calling admin.firestore() at module-load time
 * so that tests can stub the admin SDK before requiring this module.
 *
 * @returns {FirebaseFirestore.Firestore} Firestore instance
 */
function getDb() {
  if (!db) {
    db = admin.firestore();
    logger.info("[upsertPackage] Firestore instance initialized");
  }
  return db;
}

/**
 * Creates or updates a credit package.
 * Admin-only callable function (requires custom claim `admin: true`).
 *
 * Callable from: Package Manager UI (admin only)
 *
 * Request data:
 * {
 *   "packageId": "optional-existing-id", // If provided, updates existing package
 *   "name": "Package Name",
 *   "sms_quota": 1000,
 *   "price_bdt": 500,
 *   "validity_days": 30,
 *   "type": "otp" | "bulk" | "both",
 *   "is_active": true
 * }
 *
 * Response:
 * {
 *   "packageId": "package-id",
 *   "success": true
 * }
 */
exports.upsertPackage = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    logger.info("[upsertPackage] Handler invoked", { hasAuth: !!request.auth });

    try {
      // ── 1. Authentication guard ─────────────────────────────────────────
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated");
      }

      // ── 2. Admin-claim inspection ───────────────────────────────────────
      // Log the raw claim VALUE and TYPE so any token-format mismatch is
      // immediately visible in Cloud Logging (e.g. string "true" vs boolean).
      const rawAdminClaim = request.auth.token?.admin;
      logger.info("[upsertPackage] admin claim details", {
        uid: request.auth.uid,
        email: request.auth.token?.email ?? null,
        // The value that was stored via admin.auth().setCustomUserClaims()
        adminClaimValue: rawAdminClaim,
        // Must be "boolean" — if this shows "string" or "number" the claim
        // was set incorrectly and the === true check below will fail.
        adminClaimType: typeof rawAdminClaim,
        // What the guard will evaluate to
        isStrictBooleanTrue: rawAdminClaim === true,
        // All claim keys present in the decoded ID token
        tokenKeys: Object.keys(request.auth.token || {}),
      });

      // Callable functions expose decoded Auth claims on request.auth.token.
      // Custom claim must be stored as a boolean: setCustomUserClaims(uid, { admin: true })
      const isAdmin = rawAdminClaim === true;
      if (!isAdmin) {
        logger.warn(
          "[upsertPackage] permission-denied: admin claim not boolean true",
          {
            uid: request.auth.uid,
            adminClaimValue: rawAdminClaim,
            adminClaimType: typeof rawAdminClaim,
          },
        );
        throw new HttpsError(
          "permission-denied",
          "Admin claim required. Ensure the claim is a boolean true, not a string.",
        );
      }

      // ── 3. Input validation ─────────────────────────────────────────────
      const {
        packageId,
        name,
        sms_quota,
        price_bdt,
        validity_days,
        type,
        is_active,
      } = request.data;

      const packageType =
        typeof type === "string" ? type.trim().toLowerCase() : "otp";
      const supportedTypes = ["otp", "bulk", "both"];

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        throw new HttpsError(
          "invalid-argument",
          "Package name is required and must be a non-empty string",
        );
      }

      if (!sms_quota || typeof sms_quota !== "number" || sms_quota <= 0) {
        throw new HttpsError(
          "invalid-argument",
          "sms_quota must be a positive number",
        );
      }

      if (!price_bdt || typeof price_bdt !== "number" || price_bdt <= 0) {
        throw new HttpsError(
          "invalid-argument",
          "price_bdt must be a positive number",
        );
      }

      if (
        !validity_days ||
        typeof validity_days !== "number" ||
        validity_days <= 0
      ) {
        throw new HttpsError(
          "invalid-argument",
          "validity_days must be a positive number",
        );
      }

      if (!supportedTypes.includes(packageType)) {
        throw new HttpsError(
          "invalid-argument",
          "type must be one of: otp, bulk, both",
        );
      }

      // ── 4. Firestore write ──────────────────────────────────────────────
      let docRef;
      const packageData = {
        name: name.trim(),
        sms_quota,
        price_bdt,
        validity_days,
        type: packageType,
        is_active: is_active !== undefined ? is_active : true,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };

      logger.info("[upsertPackage] Writing to Firestore", {
        packageId: packageId || "(new)",
        name: name.trim(),
        sms_quota,
        price_bdt,
        validity_days,
        type: packageType,
        is_active: packageData.is_active,
      });

      if (packageId) {
        docRef = getDb().collection("packages").doc(packageId);
        await docRef.set(packageData, { merge: true });
        logger.info(
          `[upsertPackage] Updated package "${name}" with ID: ${packageId}`,
        );
      } else {
        packageData.created_at = admin.firestore.FieldValue.serverTimestamp();
        docRef = await getDb().collection("packages").add(packageData);
        logger.info(
          `[upsertPackage] Created new package "${name}" with ID: ${docRef.id}`,
        );
      }

      return {
        packageId: docRef.id,
        success: true,
      };
    } catch (error) {
      // Log the full error shape so Cloud Logging captures the root cause.
      // Include the constructor name (e.g. "HttpsError", "FirebaseError",
      // "TypeError") to distinguish unexpected crashes from intentional throws.
      logger.error("[upsertPackage] Caught error", {
        errorClass: error.constructor?.name ?? error.name ?? "Unknown",
        message: error.message,
        // HttpsError-specific
        code: error.code ?? null,
        httpStatus: error.httpErrorCode?.status ?? null,
        // First 400 chars of stack — enough to pinpoint the crash line
        stack: error.stack?.substring(0, 400) ?? null,
      });

      // Re-throw HttpsErrors as-is so the client receives the correct status
      // code (e.g. "permission-denied", "invalid-argument").
      if (error instanceof HttpsError) {
        throw error;
      }

      // Wrap any unexpected runtime error in a generic INTERNAL so the
      // client always receives a structured HttpsError, never a raw crash.
      throw new HttpsError(
        "internal",
        `Failed to upsert package: ${error.message}`,
      );
    }
  },
);

module.exports = { upsertPackage: exports.upsertPackage };
