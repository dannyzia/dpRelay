const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const firestore = admin.firestore();
const rtdb = admin.database();

exports.getCampaignStatus = onCall(
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

    const { campaignId } = request.data || {};
    if (!campaignId || typeof campaignId !== "string") {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "campaignId is required",
      );
    }

    const campaignRef = firestore.collection("bulk_campaigns").doc(campaignId);
    const campaignDoc = await campaignRef.get();

    if (!campaignDoc.exists) {
      throw new admin.functions.https.HttpsError("not-found", "Campaign not found");
    }

    const campaignData = campaignDoc.data();
    const isAdmin = request.auth.token?.admin === true;
    const userUid = request.auth.uid;

    if (!isAdmin && campaignData.ownerUid !== userUid) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "Unauthorized",
      );
    }

    const progressSnapshot = await rtdb.ref(`bulk_progress/${campaignId}`).once("value");
    const progress = progressSnapshot.exists() ? progressSnapshot.val() : null;

    return {
      ...campaignData,
      progress,
    };
  },
);

module.exports = { getCampaignStatus: exports.getCampaignStatus };
