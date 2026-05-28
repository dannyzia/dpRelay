const { onCall } = require('firebase-functions/v2/https')
const admin = require('firebase-admin')

const firestore = admin.firestore()

exports.listFailedRecipients = onCall(
  {
    region: 'asia-southeast1',
  },
  async (request) => {
    if (!request.auth) {
      throw new admin.functions.https.HttpsError(
        'unauthenticated',
        'Authentication required',
      )
    }

    const { campaignId, limit = 200 } = request.data || {}
    if (!campaignId || typeof campaignId !== 'string') {
      throw new admin.functions.https.HttpsError(
        'invalid-argument',
        'campaignId is required',
      )
    }

    const campaignRef = firestore.collection('bulk_campaigns').doc(campaignId)
    const campaignDoc = await campaignRef.get()

    if (!campaignDoc.exists) {
      throw new admin.functions.https.HttpsError('not-found', 'Campaign not found')
    }

    const campaignData = campaignDoc.data()
    const isAdmin = request.auth.token?.admin === true
    const userUid = request.auth.uid

    if (!isAdmin && campaignData.ownerUid !== userUid) {
      throw new admin.functions.https.HttpsError(
        'permission-denied',
        'Unauthorized',
      )
    }

    const normalizedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500)
    const failedSnapshot = await campaignRef
      .collection('recipients')
      .where('status', '==', 'failed')
      .orderBy('lastAttemptAt', 'desc')
      .limit(normalizedLimit)
      .get()

    const failedRecipients = failedSnapshot.docs.map((doc) => {
      const data = doc.data()
      return {
        id: doc.id,
        phone: data.phone || null,
        errorMessage: data.errorMessage || 'Unknown error',
        lastAttemptAt: data.lastAttemptAt || null,
      }
    })

    return { failedRecipients }
  },
)

module.exports = { listFailedRecipients: exports.listFailedRecipients }
