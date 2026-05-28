import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCampaignStatus, listFailedRecipients } from '../../utils/firebase'
import Button from '../../components/ui/Button'
import CampaignStats from '../../components/bulk/CampaignStats'

export default function AdminCampaignDetail() {
  const { campaignId } = useParams()
  const navigate = useNavigate()
  const [campaign, setCampaign] = useState(null)
  const [failedRecipients, setFailedRecipients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadFailedRecipients = async () => {
      if (!campaignId) return
      try {
        const response = await listFailedRecipients({ campaignId, limit: 200 })
        setFailedRecipients(response.data.failedRecipients || [])
      } catch (err) {
        console.error('Unable to load failed recipients', err)
      }
    }

    loadFailedRecipients()
  }, [campaignId])

  useEffect(() => {
    const loadCampaign = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getCampaignStatus({ campaignId })
        setCampaign(response.data)
      } catch (err) {
        setError(err.message || 'Unable to load campaign.')
      } finally {
        setLoading(false)
      }
    }

    if (campaignId) {
      loadCampaign()
    }
  }, [campaignId])

  const formatTimestamp = (value) => {
    if (!value) return 'N/A'
    if (typeof value.toDate === 'function') {
      return value.toDate().toLocaleString()
    }
    if (typeof value === 'object' && value._seconds != null) {
      return new Date(value._seconds * 1000 + (value._nanoseconds || 0) / 1e6).toLocaleString()
    }
    return new Date(value).toLocaleString()
  }

  if (loading) {
    return <div className="text-sm text-gray-500">Loading campaign details…</div>
  }

  if (!campaign) {
    return <div className="text-sm text-gray-500">Campaign not found.</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin view: {campaign.campaignName}</h1>
          <p className="mt-1 text-sm text-gray-500">Campaign metrics and delivery status.</p>
        </div>
        <Button variant="outline" onClick={() => navigate('/admin/bulk')}>
          Back to campaigns
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-gray-900">Campaign Details</h2>
          <div className="mt-4 space-y-3 text-sm text-gray-700">
            <div>
              <span className="font-semibold text-gray-900">Campaign ID:</span> {campaign.id}
            </div>
            <div>
              <span className="font-semibold text-gray-900">Status:</span> {campaign.status}
            </div>
            <div>
              <span className="font-semibold text-gray-900">Created at:</span> {formatTimestamp(campaign.createdAt)}
            </div>
            <div>
              <span className="font-semibold text-gray-900">Recipients:</span> {campaign.totalRecipients}
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-900">Message</h3>
            <p className="mt-2 text-sm text-gray-700 whitespace-pre-line">{campaign.message}</p>
          </div>
        </div>

        <CampaignStats campaign={campaign} />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Failed Recipients</h2>
            <p className="mt-1 text-sm text-gray-500">Review recipients that failed delivery for this campaign.</p>
          </div>
          <span className="text-sm font-semibold text-red-600">{failedRecipients.length} failed</span>
        </div>

        {failedRecipients.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-sm text-gray-500">
            No failed recipients have been recorded.
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">Phone</th>
                  <th className="px-4 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">Error</th>
                  <th className="px-4 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">Last attempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {failedRecipients.map((recipient) => (
                  <tr key={recipient.id}>
                    <td className="px-4 py-3 text-gray-900">{recipient.phone}</td>
                    <td className="px-4 py-3 text-gray-700">{recipient.errorMessage}</td>
                    <td className="px-4 py-3 text-gray-700">{formatTimestamp(recipient.lastAttemptAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}
    </div>
  )
}
