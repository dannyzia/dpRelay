const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const rtdb = admin.database();
const firestore = admin.firestore();

exports.listApps = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const uid = request.auth.uid;
    const isAdmin = request.auth.token?.admin === true;
    const snapshot = await rtdb.ref("registered_apps").once("value");

    if (!snapshot.exists()) {
      return { apps: [] };
    }

    const apps = [];
    const creditRefs = [];

    snapshot.forEach((child) => {
      const appData = child.val();
      const appId = child.key;
      if (!appId || typeof appId !== "string") {
        return;
      }

      if (isAdmin || appData.ownerUid === uid) {
        apps.push({
          appId,
          name: appData.name || appId,
          ownerUid: appData.ownerUid || null,
          active: appData.active === true,
          createdAt: appData.createdAt || null,
          sms_remaining: 0,
          bulk_sms_remaining: 0,
          expires_at: null,
          bulk_expires_at: null,
        });
        creditRefs.push(firestore.collection("app_credits").doc(appId));
      }
    });

    if (creditRefs.length > 0) {
      const creditDocs = await firestore.getAll(...creditRefs);
      creditDocs.forEach((docRef, index) => {
        const data = docRef.exists ? docRef.data() : {};
        if (apps[index]) {
          apps[index].sms_remaining = Number(data.sms_remaining || 0);
          apps[index].bulk_sms_remaining = Number(data.bulk_sms_remaining || 0);
          apps[index].expires_at = data.expires_at || null;
          apps[index].bulk_expires_at = data.bulk_expires_at || null;
        }
      });
    }

    return { apps };
  },
);

module.exports = { listApps: exports.listApps };
