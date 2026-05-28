import React from 'react'

export default function CampaignStats({ campaign }) {
  const items = [
    { label: 'Total Recipients', value: campaign.totalRecipients ?? 0 },
    { label: 'Sent', value: campaign.sentCount ?? 0 },
    { label: 'Delivered', value: campaign.deliveredCount ?? 0 },
    { label: 'Failed', value: campaign.failedCount ?? 0 },
    { label: 'Pending', value: campaign.pendingCount ?? 0 },
    { label: 'Cancelled', value: campaign.cancelledCount ?? 0 },
  ]

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-900">Campaign Metrics</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl bg-gray-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold text-gray-900">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
