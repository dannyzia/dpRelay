import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listCampaigns, pauseCampaign, resumeCampaign, cancelCampaign } from '../../utils/firebase'
import Button from '../../components/ui/Button'

const statusOptions = [
  { value: '', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'sending', label: 'Sending' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
]

export default function BulkCampaigns() {
  const [campaigns, setCampaigns] = useState([])
  const [statusFilter, setStatusFilter] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const navigate = useNavigate()

  const fetchCampaigns = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listCampaigns({ status: statusFilter, limit: 50 })
      setCampaigns(response.data.campaigns || [])
    } catch (err) {
      setError(err.message || 'Unable to load campaigns')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchCampaigns()
  }, [statusFilter])

  const handleAction = async (campaignId, action) => {
    setLoading(true)
    setError(null)
    try {
      if (action === 'pause') {
        await pauseCampaign({ campaignId })
      } else if (action === 'resume') {
        await resumeCampaign({ campaignId })
      } else if (action === 'cancel') {
        await cancelCampaign({ campaignId })
      }
      await fetchCampaigns()
    } catch (err) {
      setError(err.message || 'Action failed')
      setLoading(false)
    }
  }

  const filteredCampaigns = campaigns.filter((campaign) => {
    const createdAt = campaign.createdAt?.toDate
      ? campaign.createdAt.toDate().getTime()
      : new Date(campaign.createdAt).getTime()

    const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null
    const end = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : null

    if (start !== null && createdAt < start) {
      return false
    }

    if (end !== null && createdAt > end) {
      return false
    }

    return true
  })

  return (
    <div>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bulk SMS Campaigns</h1>
          <p className="mt-1 text-sm text-gray-500">
            View and manage your bulk SMS campaigns.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] md:grid-cols-[minmax(280px,_1fr)_auto]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              aria-label="Start date"
            />
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              aria-label="End date"
            />
          </div>
          <Button variant="primary" onClick={() => navigate('/dashboard/bulk/create')}>
            Create Campaign
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Campaign Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Recipients
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Sent
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Failed
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Created
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Status
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-500">
                  Loading campaigns...
                </td>
              </tr>
            ) : filteredCampaigns.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-500">
                  No campaigns found.
                </td>
              </tr>
            ) : (
              filteredCampaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {campaign.campaignName}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {campaign.totalRecipients}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600">
                    {campaign.sentCount}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-red-600">
                    {campaign.failedCount}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                    {campaign.createdAt?.toDate ? campaign.createdAt.toDate().toLocaleDateString() : new Date(campaign.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                        campaign.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : campaign.status === 'sending'
                          ? 'bg-blue-100 text-blue-800'
                          : campaign.status === 'paused'
                          ? 'bg-yellow-100 text-yellow-800'
                          : campaign.status === 'cancelled' || campaign.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {campaign.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigate(`/dashboard/bulk/${campaign.id}`)}
                    >
                      View
                    </Button>
                    {campaign.status === 'sending' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleAction(campaign.id, 'pause')}
                      >
                        Pause
                      </Button>
                    )}
                    {campaign.status === 'paused' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleAction(campaign.id, 'resume')}
                      >
                        Resume
                      </Button>
                    )}
                    {['queued', 'sending', 'paused'].includes(campaign.status) && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleAction(campaign.id, 'cancel')}
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
