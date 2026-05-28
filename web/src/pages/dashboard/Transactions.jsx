import React, { useEffect, useState } from 'react'
import { getTransactions } from '../../utils/firebase'

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadTransactions = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getTransactions({ limit: 100 })
      setTransactions(response.data.transactions || [])
    } catch (err) {
      setError(err.message || 'Unable to load transactions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTransactions()
  }, [])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
      <p className="mt-1 text-sm text-gray-500">
        Your credit purchase history and status.
      </p>

      {loading ? (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          Loading transactions…
        </div>
      ) : error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {error}
        </div>
      ) : transactions.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
          <p className="text-gray-400">No transactions found.</p>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Date
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  App
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Package
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Type
                </th>
                <th className="px-6 py-3 text-right font-semibold uppercase tracking-wider text-gray-500">
                  Credits
                </th>
                <th className="px-6 py-3 text-right font-semibold uppercase tracking-wider text-gray-500">
                  Amount
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td className="px-6 py-4 text-gray-700">
                    {transaction.requested_at?.toDate
                      ? transaction.requested_at.toDate().toLocaleDateString()
                      : transaction.requested_at
                      ? new Date(transaction.requested_at).toLocaleDateString()
                      : 'N/A'}
                  </td>
                  <td className="px-6 py-4 text-gray-900">{transaction.appId}</td>
                  <td className="px-6 py-4 text-gray-700">
                    {transaction.packageName || transaction.package_id}
                  </td>
                  <td className="px-6 py-4 text-gray-700 capitalize">{transaction.type}</td>
                  <td className="px-6 py-4 text-right font-semibold text-gray-900">
                    {transaction.sms_quota?.toLocaleString() ?? '0'}
                  </td>
                  <td className="px-6 py-4 text-right text-gray-700">
                    ৳{transaction.amount_bdt?.toLocaleString() ?? '0'}
                  </td>
                  <td className="px-6 py-4">
                    <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700">
                      {transaction.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
