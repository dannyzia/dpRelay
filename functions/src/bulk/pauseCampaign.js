const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const firestore = admin.firestore();
const rtdb = admin.database();

exports.pauseCampaign = onCall(
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
    const uid = request.auth.uid;

    if (!isAdmin && campaignData.ownerUid !== uid) {
      throw new admin.functions.https.HttpsError("permission-denied", "Unauthorized");
    }

    if (!["sending", "queued"].includes(campaignData.status)) {
      throw new admin.functions.https.HttpsError(
        "failed-precondition",
        "Campaign cannot be paused in its current state",
      );
    }

    await campaignRef.update({ status: "paused" });
    await rtdb.ref(`bulk_progress/${campaignId}`).update({
      status: "paused",
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return {
      success: true,
      status: "paused",
    };
  },
);

module.exports = { pauseCampaign: exports.pauseCampaign };
