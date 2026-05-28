import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listApps } from '../../utils/firebase'
import Button from '../../components/ui/Button'

export default function CreditsOverview() {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadApps = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await listApps()
        setApps(response.data.apps || [])
      } catch (err) {
        setError(err.message || 'Unable to load apps')
      } finally {
        setLoading(false)
      }
    }

    loadApps()
  }, [])

  return (
    <div>
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Credits Overview</h1>
          <p className="mt-1 text-sm text-gray-500">
            View OTP and bulk credit balances for your registered apps.
          </p>
        </div>
        <Link to="/dashboard/buy-credits">
          <Button variant="primary">Buy Credits</Button>
        </Link>
      </div>

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          Loading credit balances…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {error}
        </div>
      ) : apps.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          No registered apps found. Create an app to start buying credits.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {apps.map((app) => (
            <div key={app.appId} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">{app.name}</p>
                  <p className="mt-2 text-xl font-bold text-gray-900">{app.appId}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${app.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                  {app.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-500">OTP Credits</p>
                  <p className="mt-3 text-3xl font-semibold text-gray-900">{app.sms_remaining.toLocaleString()}</p>
                  <p className="mt-2 text-sm text-gray-500">Remaining OTP credits</p>
                </div>
                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-500">Bulk Credits</p>
                  <p className="mt-3 text-3xl font-semibold text-gray-900">{app.bulk_sms_remaining.toLocaleString()}</p>
                  <p className="mt-2 text-sm text-gray-500">Remaining bulk SMS credits</p>
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-500">OTP expiry</p>
                  <p className="mt-2 text-sm text-gray-700">{app.expires_at ? new Date(app.expires_at).toLocaleDateString() : 'N/A'}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-500">Bulk expiry</p>
                  <p className="mt-2 text-sm text-gray-700">{app.bulk_expires_at ? new Date(app.bulk_expires_at).toLocaleDateString() : 'N/A'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
