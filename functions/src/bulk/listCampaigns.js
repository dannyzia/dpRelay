const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const firestore = admin.firestore();

exports.listCampaigns = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        "unauthenticated",
        "Authentication required",
      );
    }

    const isAdmin = request.auth.token?.admin === true;
    const uid = request.auth.uid;
    const { appId, status, limit = 20, pageToken } = request.data || {};
    const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    let query = firestore.collection("bulk_campaigns");

    if (!isAdmin) {
      query = query.where("ownerUid", "==", uid);
    }

    if (appId && typeof appId === "string") {
      query = query.where("appId", "==", appId);
    }

    if (status && typeof status === "string") {
      query = query.where("status", "==", status);
    }

    query = query.orderBy(admin.firestore.FieldPath.documentId(), "asc");

    if (pageToken && typeof pageToken === "string") {
      query = query.startAfter(pageToken);
    }

    const snapshot = await query.limit(normalizedLimit).get();
    const campaigns = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const nextPageToken =
      snapshot.docs.length === normalizedLimit
        ? snapshot.docs[snapshot.docs.length - 1].id
        : null;

    return {
      campaigns,
      nextPageToken,
    };
  },
);

module.exports = { listCampaigns: exports.listCampaigns };
