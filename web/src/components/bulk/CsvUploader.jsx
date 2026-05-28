import React, { useState } from 'react'

const MAX_FILE_BYTES = 1024 * 1024

export default function CsvUploader({ value, onChange, onFileUpload }) {
  const [error, setError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const processFile = async (file) => {
    if (!file) {
      return
    }

    if (file.size > MAX_FILE_BYTES) {
      setError('CSV file must be 1 MB or smaller.')
      return
    }

    const text = await file.text()
    setError(null)
    onFileUpload(text)
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    await processFile(file)
  }

  const handleDrop = async (event) => {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files?.[0]
    await processFile(file)
  }

  const handleDragOver = (event) => {
    event.preventDefault()
    setDragActive(true)
  }

  const handleDragLeave = () => {
    setDragActive(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-medium text-gray-700">Recipient CSV</span>
        <span className="text-sm text-gray-500">One phone number per line; CSV headers are optional.</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-[220px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
          placeholder="+88017XXXXXXXX\n+88018XXXXXXXX"
        />

        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p className="text-sm font-semibold text-gray-900">Upload CSV</p>
          <p className="mt-2 text-sm text-gray-600">
            Drag and drop a CSV file, or use the file picker.
          </p>

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`mt-4 rounded-lg border px-3 py-6 text-center text-sm transition ${
              dragActive ? 'border-brand-500 bg-brand-50' : 'border-dashed border-gray-300 bg-white'
            }`}
          >
            <p className="text-gray-700">Drop a file here</p>
            <p className="mt-2 text-xs text-gray-500">CSV file only, max 1 MB</p>
          </div>

          <label className="mt-4 flex cursor-pointer items-center justify-center rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50">
            Select file
            <input type="file" accept=".csv,text/csv" onChange={handleFile} className="sr-only" />
          </label>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
