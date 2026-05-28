import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { onValue, ref } from 'firebase/database';
import { rtdb } from '../../utils/firebase';

/**
 * Admin home — overview of system health and quick-action cards.
 */
export default function AdminHome() {
  const [stats, setStats] = useState(null)
  const [loadingStats, setLoadingStats] = useState(true)

  useEffect(() => {
    const statsRef = ref(rtdb, 'stats')
    const unsubscribe = onValue(statsRef, (snapshot) => {
      setStats(snapshot.exists() ? snapshot.val() : null)
      setLoadingStats(false)
    })

    return () => unsubscribe()
  }, [])

  const renderValue = (value) => (value === undefined || value === null ? '—' : value)

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
      <p className="mt-1 text-sm text-gray-400">
        System overview and management.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          to="/admin/packages"
          className="rounded-lg border border-gray-700 bg-gray-800 p-6 transition hover:bg-gray-750"
        >
          <h2 className="text-lg font-semibold text-white">Manage Packages</h2>
          <p className="mt-1 text-sm text-gray-400">
            Create, edit, and deactivate credit packages.
          </p>
        </Link>

        <Link
          to="/admin/transactions"
          className="rounded-lg border border-gray-700 bg-gray-800 p-6 transition hover:bg-gray-750"
        >
          <h2 className="text-lg font-semibold text-white">
            Approve Transactions
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Review and approve pending bKash credit requests.
          </p>
        </Link>

        <Link
          to="/admin/metrics"
          className="rounded-lg border border-gray-700 bg-gray-800 p-6 transition hover:bg-gray-750"
        >
          <h2 className="text-lg font-semibold text-white">Metrics</h2>
          <p className="mt-1 text-sm text-gray-400">
            OTP delivery stats, revenue, and usage trends.
          </p>
        </Link>
      </div>

      <div className="mt-10">
        <h2 className="text-xl font-semibold text-white">Bulk SMS metrics</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Bulk Sent Today', value: renderValue(stats?.bulk_sent_today) },
            { label: 'Bulk Failed Today', value: renderValue(stats?.bulk_failed_today) },
            { label: 'Active Bulk Campaigns', value: renderValue(stats?.bulk_active_campaigns) },
            { label: 'Bulk Campaigns Today', value: renderValue(stats?.bulk_total_today) },
          ].map((stat) => (
            <div key={stat.label} className="rounded-lg border border-gray-700 bg-gray-800 p-6">
              <p className="text-sm font-medium text-gray-400">{stat.label}</p>
              <p className="mt-3 text-3xl font-bold text-white">
                {loadingStats ? 'Loading…' : stat.value}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
