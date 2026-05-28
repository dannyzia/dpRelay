const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const firestore = admin.firestore();
const rtdb = admin.database();

exports.resumeCampaign = onCall(
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

    if (campaignData.status !== "paused") {
      throw new admin.functions.https.HttpsError(
        "failed-precondition",
        "Campaign is not paused",
      );
    }

    await campaignRef.update({ status: "sending" });
    await rtdb.ref(`bulk_progress/${campaignId}`).update({
      status: "sending",
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return {
      success: true,
      status: "sending",
    };
  },
);

module.exports = { resumeCampaign: exports.resumeCampaign };
