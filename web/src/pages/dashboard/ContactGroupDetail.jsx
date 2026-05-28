import React, { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { listContactGroupPhones } from '../../utils/firebase'
import Button from '../../components/ui/Button'

const PAGE_SIZE = 100

export default function ContactGroupDetail() {
  const { groupId } = useParams()
  const navigate = useNavigate()

  const [phones, setPhones] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [nextPageToken, setNextPageToken] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalCount, setTotalCount] = useState(null)

  const loadPhones = useCallback(
    async (token) => {
      try {
        const response = await listContactGroupPhones({
          groupId,
          pageSize: PAGE_SIZE,
          pageToken: token || undefined,
        })
        const data = response.data
        if (!token) {
          setPhones(data.phones || [])
        } else {
          setPhones((prev) => [...prev, ...(data.phones || [])])
        }
        setNextPageToken(data.nextPageToken || null)
      } catch (err) {
        setError(err.message || 'Unable to load phone numbers.')
      }
    },
    [groupId]
  )

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await listContactGroupPhones({
          groupId,
          pageSize: PAGE_SIZE,
        })
        if (cancelled) {
          return
        }
        const data = response.data
        setPhones(data.phones || [])
        setNextPageToken(data.nextPageToken || null)
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Unable to load phone numbers.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    if (groupId) {
      init()
    }
    return () => {
      cancelled = true
    }
  }, [groupId])

  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      await loadPhones(nextPageToken)
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <svg
          className="h-6 w-6 animate-spin text-brand-600"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span className="ml-3 text-sm text-gray-500">Loading phones…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <button
          onClick={() => navigate('/dashboard/contact-groups')}
          className="mb-4 text-sm font-medium text-brand-600 hover:text-brand-700"
        >
          &larr; Contact Groups
        </button>
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Back link */}
      <button
        onClick={() => navigate('/dashboard/contact-groups')}
        className="mb-4 text-sm font-medium text-brand-600 hover:text-brand-700"
      >
        &larr; Contact Groups
      </button>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-700">
              Phone Numbers
            </h2>
            <span className="text-xs text-gray-500">
              Showing {phones.length} number{phones.length !== 1 ? 's' : ''}
              {nextPageToken ? ' (more available)' : ''}
            </span>
          </div>
        </div>

        {phones.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <p className="text-sm text-gray-500">
              This group has no phone numbers.
            </p>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                  Phone Number
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {phones.map((phone, idx) => (
                <tr key={`${phone}-${idx}`} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-sm text-gray-900">
                    {phone}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {nextPageToken && (
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load More'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
