const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const firestore = admin.firestore();
const rtdb = admin.database();

exports.retryFailedJobs = onCall(
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

    const failedSnapshot = await campaignRef
      .collection("recipients")
      .where("status", "==", "failed")
      .get();

    const retryCount = failedSnapshot.size;
    if (retryCount === 0) {
      return {
        retryCount: 0,
        creditsDeducted: 0,
      };
    }

    const creditsRef = firestore.collection("app_credits").doc(campaignData.appId);

    await firestore.runTransaction(async (t) => {
      const creditsDoc = await t.get(creditsRef);
      const creditsData = creditsDoc.exists ? creditsDoc.data() : {};
      const currentBulkRemaining = Number(creditsData.bulk_sms_remaining || 0);

      if (currentBulkRemaining < retryCount) {
        throw new admin.functions.https.HttpsError(
          "resource-exhausted",
          "insufficient_bulk_credits",
        );
      }

      t.set(
        creditsRef,
        {
          bulk_sms_remaining: currentBulkRemaining - retryCount,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    let batch = firestore.batch();
    let batchCount = 0;
    for (const doc of failedSnapshot.docs) {
      batch.update(doc.ref, {
        status: "pending",
        attempts: 0,
        errorCode: null,
        errorMessage: null,
      });
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

    await rtdb.ref(`bulk_progress/${campaignId}`).update({
      totalCount: admin.database.ServerValue.increment(retryCount),
      status: "sending",
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    await campaignRef.update({
      status: "sending",
      totalRecipients: admin.firestore.FieldValue.increment(retryCount),
    });

    return {
      retryCount,
      creditsDeducted: retryCount,
    };
  },
);

module.exports = { retryFailedJobs: exports.retryFailedJobs };
