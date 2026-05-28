import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  listContactGroups,
  createContactGroup,
  deleteContactGroup,
} from '../../utils/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Button from '../../components/ui/Button'
import Modal from '../../components/ui/Modal'
import CsvUploader from '../../components/bulk/CsvUploader'
import PhonePreviewTable from '../../components/bulk/PhonePreviewTable'
import { parseCsvPhones } from '../../utils/bulkUtils'
import { UserGroupIcon, TrashIcon, EyeIcon } from '@heroicons/react/24/outline'

const MAX_GROUPS = 50

export default function ContactGroups() {
  const { bulkEnabled } = useAuth()
  const navigate = useNavigate()

  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupCsv, setNewGroupCsv] = useState('')
  const [createError, setCreateError] = useState(null)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listContactGroups()
      setGroups(response.data.groups || [])
    } catch (err) {
      setError(err.message || 'Unable to load contact groups.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (bulkEnabled) {
      loadGroups()
    }
  }, [bulkEnabled, loadGroups])

  const parsedCsv = parseCsvPhones(newGroupCsv)
  const validCount = parsedCsv.validPhones.length
  const invalidCount = parsedCsv.invalidCount
  const canSave =
    newGroupName.trim().length > 0 &&
    newGroupName.trim().length <= 100 &&
    validCount > 0 &&
    invalidCount === 0

  const handleCreate = async () => {
    setCreateError(null)
    setCreating(true)
    try {
      await createContactGroup({
        name: newGroupName.trim(),
        phones: parsedCsv.validPhones,
      })
      setShowCreateModal(false)
      setNewGroupName('')
      setNewGroupCsv('')
      await loadGroups()
    } catch (err) {
      setCreateError(err.message || 'Failed to create group.')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) {
      return
    }
    setDeleteError(null)
    setDeleting(true)
    try {
      await deleteContactGroup({ groupId: deleteTarget.groupId })
      setDeleteTarget(null)
      await loadGroups()
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete group.')
    } finally {
      setDeleting(false)
    }
  }

  const formatRelativeDate = (isoString) => {
    if (!isoString) {
      return 'N/A'
    }
    const date = new Date(isoString)
    const now = Date.now()
    const diffMs = now - date.getTime()
    const diffSec = Math.floor(diffMs / 1000)
    const diffMin = Math.floor(diffSec / 60)
    const diffHr = Math.floor(diffMin / 60)
    const diffDay = Math.floor(diffHr / 24)

    if (diffSec < 60) {
      return 'just now'
    }
    if (diffMin < 60) {
      return `${diffMin}m ago`
    }
    if (diffHr < 24) {
      return `${diffHr}h ago`
    }
    if (diffDay < 30) {
      return `${diffDay}d ago`
    }
    return date.toLocaleDateString()
  }

  if (!bulkEnabled) {
    return (
      <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-6 text-sm text-yellow-800">
        Bulk SMS is currently disabled. Please contact support.
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contact Groups</h1>
          <p className="mt-1 text-sm text-gray-500">
            Save and reuse recipient lists across campaigns.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">
            {groups.length} / {MAX_GROUPS} groups used
          </span>
          <Button
            variant="primary"
            onClick={() => {
              setCreateError(null)
              setShowCreateModal(true)
            }}
            disabled={groups.length >= MAX_GROUPS}
            title={
              groups.length >= MAX_GROUPS
                ? '50 group limit reached'
                : undefined
            }
          >
            New Group
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error}{' '}
          <button
            onClick={loadGroups}
            className="ml-2 font-medium text-red-800 underline hover:text-red-900"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
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
          <span className="ml-3 text-sm text-gray-500">Loading…</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && groups.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-20">
          <UserGroupIcon className="h-16 w-16 text-gray-300" />
          <h3 className="mt-4 text-lg font-medium text-gray-600">
            No contact groups yet.
          </h3>
          <p className="mt-2 text-sm text-gray-500">
            Create a group to save and reuse recipient lists across campaigns.
          </p>
          <Button
            variant="primary"
            className="mt-6"
            onClick={() => setShowCreateModal(true)}
          >
            New Group
          </Button>
        </div>
      )}

      {/* Table */}
      {!loading && groups.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                  Phones
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-4 py-3 text-right font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {groups.map((group) => (
                <tr key={group.groupId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {group.name}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {group.phoneCount.toLocaleString()} numbers
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatRelativeDate(group.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          navigate(
                            `/dashboard/contact-groups/${group.groupId}`
                          )
                        }
                      >
                        <EyeIcon className="mr-1 h-4 w-4" />
                        View
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null)
                          setDeleteTarget(group)
                        }}
                      >
                        <TrashIcon className="mr-1 h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Group Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Contact Group"
        size="lg"
      >
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Group Name
            </span>
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="e.g. Weekly Promo Customers"
              maxLength={100}
            />
          </label>

          <div>
            <span className="text-sm font-medium text-gray-700">
              Phone Numbers
            </span>
            <CsvUploader
              value={newGroupCsv}
              onChange={setNewGroupCsv}
              onFileUpload={setNewGroupCsv}
            />
          </div>

          {/* Validation summary */}
          {newGroupCsv.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500">Valid</p>
                <p className="text-lg font-semibold text-green-700">
                  {validCount}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500">Invalid</p>
                <p className="text-lg font-semibold text-red-700">
                  {invalidCount}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500">Duplicates</p>
                <p className="text-lg font-semibold text-yellow-700">
                  {parsedCsv.duplicateCount}
                </p>
              </div>
            </div>
          )}

          {parsedCsv.validPhones.length > 0 && (
            <PhonePreviewTable rows={parsedCsv.rows} />
          )}

          {createError && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {createError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
            <Button
              variant="outline"
              onClick={() => setShowCreateModal(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canSave || creating}
              onClick={handleCreate}
            >
              {creating ? 'Saving…' : 'Save Group'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Contact Group"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Delete &ldquo;{deleteTarget?.name}&rdquo;? This will not affect
            campaigns already created.
          </p>
          {deleteError && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {deleteError}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Confirm Delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
