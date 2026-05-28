const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const firestore = admin.firestore();
const rtdb = admin.database();

exports.cancelCampaign = onCall(
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

    if (!["queued", "sending", "paused"].includes(campaignData.status)) {
      throw new admin.functions.https.HttpsError(
        "failed-precondition",
        "Campaign cannot be cancelled in its current state",
      );
    }

    const recipientsSnapshot = await campaignRef
      .collection("recipients")
      .where("status", "in", ["pending", "queued", "retrying"])
      .get();
    const unprocessedCount = recipientsSnapshot.size;

    const pendingSnapshot = await rtdb.ref("pending_sms").once("value");
    const pendingDeletes = [];
    let inFlightCount = 0;

    if (pendingSnapshot.exists()) {
      pendingSnapshot.forEach((childSnapshot) => {
        const entry = childSnapshot.val();
        if (entry && entry.batchId === campaignId) {
          inFlightCount += 1;
          pendingDeletes.push(childSnapshot.key);
        }
      });
    }

    const creditsToRefund = unprocessedCount + inFlightCount;

    await firestore.runTransaction(async (t) => {
      const creditsRef = firestore.collection("app_credits").doc(campaignData.appId);
      const creditsDoc = await t.get(creditsRef);
      const creditsData = creditsDoc.exists ? creditsDoc.data() : {};
      const currentBulkRemaining = Number(creditsData.bulk_sms_remaining || 0);
      t.set(
        creditsRef,
        {
          bulk_sms_remaining: currentBulkRemaining + creditsToRefund,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    await campaignRef.update({
      status: "cancelled",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await rtdb.ref(`bulk_progress/${campaignId}`).remove();

    const updates = {};
    for (const pendingId of pendingDeletes) {
      updates[`pending_sms/${pendingId}`] = null;
    }
    if (Object.keys(updates).length > 0) {
      await rtdb.ref().update(updates);
    }

    let batch = firestore.batch();
    let batchCount = 0;
    for (const doc of recipientsSnapshot.docs) {
      batch.update(doc.ref, { status: "cancelled" });
      batchCount += 1;

      if (batchCount >= 450) {
        await batch.commit();
        batch = firestore.batch();
        batchCount = 0;
      }
    }
    if (batchCount > 0) {
      await batch.commit();
    }

    return {
      success: true,
      creditsRefunded: creditsToRefund,
    };
  },
);

module.exports = { cancelCampaign: exports.cancelCampaign };
