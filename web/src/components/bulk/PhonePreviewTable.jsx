import React from 'react'

export default function PhonePreviewTable({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm text-gray-500">Upload a CSV file to preview recipient phone numbers.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Phone</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {rows.slice(0, 10).map((row, index) => (
            <tr key={`${row.phone}-${index}`}>
              <td className="px-4 py-3 text-gray-900">{row.phone || '—'}</td>
              <td className={`px-4 py-3 font-semibold ${row.valid ? 'text-green-700' : 'text-red-700'}`}>
                {row.valid ? 'Valid' : 'Invalid'}
              </td>
              <td className="px-4 py-3 text-gray-600">{row.reason || 'OK'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 10 && (
        <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500">
          Showing first 10 of {rows.length} rows.
        </div>
      )}
    </div>
  )
}
