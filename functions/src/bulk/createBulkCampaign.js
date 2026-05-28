const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const {
  validateE164,
  validateBulkMessage,
  deduplicatePhones,
  checkBulkCreditBalance,
  checkDailyAppQuota,
} = require("./bulkHelpers");

const firestore = admin.firestore();
const rtdb = admin.database();
const logger = require("firebase-functions/logger");

const BULK_SMS_PER_CAMPAIGN_LIMIT = Number(process.env.BULK_SMS_PER_CAMPAIGN_LIMIT) || 10000;

function timestampToMillis(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object" && value._seconds !== undefined) {
    return value._seconds * 1000 + (value._nanoseconds || 0) / 1000000;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

exports.createBulkCampaign = onCall(
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

    const uid = request.auth.uid;
    const isAdmin = request.auth.token?.admin === true;
    const { appId, campaignName, message, phones, sourceType, sourceGroupIds } = request.data || {};

    if (
      !appId ||
      typeof appId !== "string" ||
      !campaignName ||
      typeof campaignName !== "string" ||
      campaignName.trim().length === 0 ||
      campaignName.length > 100 ||
      !message ||
      typeof message !== "string"
    ) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        "appId, campaignName, and message are required",
      );
    }

    // Resolve phone list from either CSV array or contact groups
    let resolvedPhones;
    let campaignSourceType = 'csv';
    let campaignSourceGroupIds = [];

    if (sourceType === 'contactGroups') {
      campaignSourceType = 'contactGroups';
      if (!Array.isArray(sourceGroupIds) || sourceGroupIds.length === 0) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "sourceGroupIds is required when sourceType is 'contactGroups'",
        );
      }
      if (sourceGroupIds.length > 10) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "Maximum 10 contact groups allowed",
        );
      }

      // Validate each group exists and belongs to the caller
      for (const groupId of sourceGroupIds) {
        if (typeof groupId !== "string" || !groupId) {
          throw new admin.functions.https.HttpsError(
            "invalid-argument",
            `Invalid group ID: ${groupId}`,
          );
        }

        const groupDoc = await firestore.collection("contactGroups").doc(groupId).get();
        if (!groupDoc.exists) {
          throw new admin.functions.https.HttpsError(
            "not-found",
            `Contact group not found: ${groupId}`,
          );
        }
        if (groupDoc.data().uid !== uid) {
          throw new admin.functions.https.HttpsError(
            "permission-denied",
            `You do not have access to group: ${groupId}`,
          );
        }
      }

      // Read all phones from selected groups and de-duplicate
      const phoneSet = new Set();
      for (const groupId of sourceGroupIds) {
        const phonesQuery = await firestore
          .collection("contactGroups")
          .doc(groupId)
          .collection("phones")
          .get();

        phonesQuery.docs.forEach((doc) => {
          phoneSet.add(doc.data().phone);
        });
      }

      resolvedPhones = Array.from(phoneSet);
      campaignSourceGroupIds = sourceGroupIds;

      if (resolvedPhones.length === 0) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "Selected groups contain no valid phone numbers",
        );
      }

      if (resolvedPhones.length > BULK_SMS_PER_CAMPAIGN_LIMIT) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          `Combined phone count (${resolvedPhones.length}) exceeds campaign limit of ${BULK_SMS_PER_CAMPAIGN_LIMIT}`,
        );
      }
    } else {
      // Original CSV behavior
      if (!Array.isArray(phones)) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "phones array is required",
        );
      }
      if (phones.length === 0 || phones.length > BULK_SMS_PER_CAMPAIGN_LIMIT) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          `phones must contain between 1 and ${BULK_SMS_PER_CAMPAIGN_LIMIT} entries`,
        );
      }
      resolvedPhones = phones;
    }

    const bulkFlagSnapshot = await rtdb.ref("config/bulk_enabled").once("value");
    const bulkEnabled = bulkFlagSnapshot.exists() ? bulkFlagSnapshot.val() === true : false;

    if (!bulkEnabled) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "bulk_not_enabled",
      );
    }

    const appSnapshot = await rtdb.ref(`registered_apps/${appId}`).once("value");
    if (!appSnapshot.exists()) {
      throw new admin.functions.https.HttpsError("not-found", "App not found");
    }

    const appData = appSnapshot.val();
    const ownerUid = appData.ownerUid;

    if (!isAdmin && uid !== ownerUid) {
      throw new admin.functions.https.HttpsError(
        "permission-denied",
        "Only the app owner or admin can create bulk campaigns",
      );
    }

    const messageValidation = validateBulkMessage(message);

    if (!messageValidation.valid) {
      throw new admin.functions.https.HttpsError(
        "invalid-argument",
        messageValidation.error,
      );
    }

    // Validate phone numbers for CSV sourceType only (contact groups are pre-validated)
    if (campaignSourceType === 'csv') {
      const invalidPhones = resolvedPhones.filter((phone) => !validateE164(phone));
      if (invalidPhones.length > 0) {
        throw new admin.functions.https.HttpsError(
          "invalid-argument",
          "One or more phone numbers are not valid E.164 format",
        );
      }
    }

    const { unique, duplicates, duplicateCount } = deduplicatePhones(resolvedPhones);
    const uniqueCount = unique.length;

    const now = Date.now();
    const todayStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );

    const dailyRemaining = await checkDailyAppQuota(appId, firestore, todayStart);
    if (dailyRemaining < uniqueCount) {
      throw new admin.functions.https.HttpsError(
        "resource-exhausted",
        "daily_quota_exceeded",
      );
    }

    const creditsDocRef = firestore.collection("app_credits").doc(appId);
    const campaignId = crypto.randomUUID();

    try {
      await firestore.runTransaction(async (t) => {
        const creditsDoc = await t.get(creditsDocRef);
        const creditsData = creditsDoc.exists ? creditsDoc.data() : {};
        const currentBulkRemaining = Number(creditsData.bulk_sms_remaining || 0);
        const bulkExpiresAt = timestampToMillis(creditsData.bulk_expires_at);

        if (bulkExpiresAt !== null && bulkExpiresAt <= now) {
          throw new Error("credits_expired");
        }

        if (currentBulkRemaining < uniqueCount) {
          throw new Error("insufficient_bulk_credits");
        }

        t.set(
          creditsDocRef,
          {
            appId,
            ownerUid: ownerUid || null,
            bulk_sms_remaining: currentBulkRemaining - uniqueCount,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
    } catch (error) {
      if (error.message === "insufficient_bulk_credits") {
        throw new admin.functions.https.HttpsError(
          "resource-exhausted",
          "insufficient_bulk_credits",
        );
      }
      if (error.message === "credits_expired") {
        throw new admin.functions.https.HttpsError(
          "resource-exhausted",
          "insufficient_bulk_credits",
        );
      }
      logger.error("[createBulkCampaign] credit reservation failed:", error);
      throw new admin.functions.https.HttpsError(
        "internal",
        "Failed to reserve bulk credits",
      );
    }

    const campaignRef = firestore.collection("bulk_campaigns").doc(campaignId);
    const recipientCollection = campaignRef.collection("recipients");
    const bulkProgressRef = rtdb.ref(`bulk_progress/${campaignId}`);
    const auditRoot = firestore.collection("app_credits").doc(appId).collection("bulk_usage");

    const campaignData = {
      id: campaignId,
      appId,
      ownerUid: ownerUid || null,
      campaignName: campaignName.trim(),
      message,
      sourceType: campaignSourceType,
      sourceGroupIds: campaignSourceGroupIds.length > 0 ? campaignSourceGroupIds : null,
      status: "queued",
      totalRecipients: uniqueCount,
      sentCount: 0,
      failedCount: 0,
      queuedCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: null,
      completedAt: null,
      bulkCreditCost: uniqueCount,
      errorMessage: null,
      nextRecipientIndex: 0,
    };

    let batch = firestore.batch();
    batch.set(campaignRef, campaignData);

    let recipientIndex = 0;
    for (const phone of unique) {
      const recipientRef = recipientCollection.doc();
      batch.set(recipientRef, {
        phone,
        index: recipientIndex,
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
        errorCode: null,
        errorMessage: null,
      });
      recipientIndex += 1;

      if (recipientIndex % 450 === 0) {
        await batch.commit();
        batch = firestore.batch();
      }
    }

    if (recipientIndex % 450 !== 0) {
      await batch.commit();
    }

    await bulkProgressRef.set({
      campaignId,
      sentCount: 0,
      failedCount: 0,
      totalCount: uniqueCount,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
      status: "queued",
    });

    const auditChunks = [];
    for (const phone of unique) {
      const phoneHash = crypto.createHash("sha256").update(phone).digest("hex");
      const auditRef = auditRoot.doc();
      auditChunks.push({
        ref: auditRef,
        data: {
          deducted_at: admin.firestore.FieldValue.serverTimestamp(),
          campaign_id: campaignId,
          phone_hash: phoneHash,
        },
      });
    }

    let auditBatch = firestore.batch();
    let auditCount = 0;
    for (const item of auditChunks) {
      auditBatch.set(item.ref, item.data);
      auditCount += 1;

      if (auditCount >= 450) {
        await auditBatch.commit();
        auditBatch = firestore.batch();
        auditCount = 0;
      }
    }

    if (auditCount > 0) {
      await auditBatch.commit();
    }

    const response = {
      campaignId,
      totalRecipients: uniqueCount,
      creditsReserved: uniqueCount,
      charset: messageValidation.charset,
      status: "queued",
    };

    if (duplicateCount > 0) {
      response.duplicateCount = duplicateCount;
    }

    return response;
  },
);

module.exports = { createBulkCampaign: exports.createBulkCampaign };
