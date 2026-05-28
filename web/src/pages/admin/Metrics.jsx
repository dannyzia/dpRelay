import React, { useEffect, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { rtdb } from '../../utils/firebase'

/**
 * Metrics — OTP delivery stats, revenue, and usage trends.
 */
export default function Metrics() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const statsRef = ref(rtdb, 'stats')
    const unsubscribe = onValue(statsRef, (snapshot) => {
      setStats(snapshot.exists() ? snapshot.val() : null)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const renderValue = (value, suffix = '') => {
    if (value === null || value === undefined) {
      return '—'
    }
    return `${value}${suffix}`
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Metrics</h1>
        <p className="mt-1 text-sm text-gray-400">
          OTP and bulk campaign performance at a glance.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Total OTPs Today</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.total_today)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">OTP Success Rate</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.success_rate, '%')}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Pending Queue</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.queue_depth)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Bulk Campaigns Today</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.bulk_total_today)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Bulk Sent Today</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.bulk_sent_today)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Bulk Failed Today</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.bulk_failed_today)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Active Bulk Campaigns</p>
          <p className="mt-3 text-3xl font-bold text-white">
            {loading ? 'Loading…' : renderValue(stats?.bulk_active_campaigns)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm font-medium text-gray-400">Last Updated</p>
          <p className="mt-3 text-base font-semibold text-white">
            {loading || !stats?.updated_at
              ? '—'
              : new Date(stats.updated_at).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  )
}
