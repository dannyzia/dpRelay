const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const db = admin.firestore();

/**
 * Lists credit packages.
 *
 * - Admin users see ALL packages (active and inactive).
 * - Non-admin (client) users see only active packages.
 * - Results are sorted by price ascending (in-memory sort to avoid
 *   Firestore excluding documents that lack the price_bdt field).
 *
 * @param {import('firebase-functions/v2/https').CallableRequest} request
 * @returns {{ packages: Array }}
 */
exports.listPackages = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const isAdmin = request.auth.token?.admin === true;

    let query = db.collection("packages");

    // Clients only see active packages; admins see everything.
    if (!isAdmin) {
      query = query.where("is_active", "==", true);
    }

    const snapshot = await query.get();
    const packages = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Sort in-memory: group by type (otp → bulk → both) then by price
    // ascending within each group, so documents missing price_bdt are not excluded.
    const typeOrder = { otp: 0, bulk: 1, both: 2 };
    packages.sort((a, b) => {
      const tA = typeOrder[(a.type || "otp").toLowerCase()] ?? 0;
      const tB = typeOrder[(b.type || "otp").toLowerCase()] ?? 0;
      if (tA !== tB) return tA - tB;
      return (a.price_bdt ?? 0) - (b.price_bdt ?? 0);
    });

    logger.info("[listPackages] Returning packages", {
      uid: request.auth.uid,
      isAdmin,
      count: packages.length,
    });

    return { packages };
  },
);

module.exports = { listPackages: exports.listPackages };
