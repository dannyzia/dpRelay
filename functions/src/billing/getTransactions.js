const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const db = admin.firestore();

exports.getTransactions = onCall(
  {
    region: "asia-southeast1",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const uid = request.auth.uid;
    const isAdmin = request.auth.token?.admin === true;
    const { status, limit = 50, pageToken } = request.data || {};
    const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

    let query = db.collection("transactions").orderBy("requested_at", "desc");

    if (!isAdmin) {
      query = query.where("ownerUid", "==", uid);
    }

    if (status && typeof status === "string") {
      query = query.where("status", "==", status);
    }

    // If a pageToken (document ID) is provided, use startAfter with the doc snapshot
    // to maintain a reliable cursor across serialization boundaries.
    if (pageToken && typeof pageToken === "string") {
      const cursorDoc = await db
        .collection("transactions")
        .doc(pageToken)
        .get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snapshot = await query.limit(normalizedLimit).get();
    const transactions = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const packageIds = [
      ...new Set(
        transactions
          .map((transaction) => transaction.package_id)
          .filter(Boolean),
      ),
    ];
    const packageMap = {};

    if (packageIds.length > 0) {
      const packageRefs = packageIds.map((packageId) =>
        db.collection("packages").doc(packageId),
      );
      const packageDocs = await db.getAll(...packageRefs);
      packageDocs.forEach((packageDoc) => {
        if (!packageDoc.exists) {
          return;
        }
        packageMap[packageDoc.id] = packageDoc.data();
      });
    }

    const formattedTransactions = transactions.map((transaction) => {
      const packageData = packageMap[transaction.package_id] || {};
      // Convert Firestore Timestamps to ISO strings so they survive
      // JSON serialisation through the onCall response.
      return {
        ...transaction,
        requested_at:
          transaction.requested_at?.toDate?.()?.toISOString() ?? null,
        approved_at: transaction.approved_at?.toDate?.()?.toISOString() ?? null,
        updated_at: transaction.updated_at?.toDate?.()?.toISOString() ?? null,
        type: packageData.type || "otp",
        packageName: packageData.name || null,
      };
    });

    // Use the document ID as the cursor token — survives serialization.
    const nextPageToken =
      transactions.length === normalizedLimit
        ? transactions[transactions.length - 1].id || null
        : null;

    return { transactions: formattedTransactions, nextPageToken };
  },
);

module.exports = { getTransactions: exports.getTransactions };
