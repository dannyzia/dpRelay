import React, { useCallback, useEffect, useState } from 'react'
import {
  listMessageTemplates,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
} from '../../utils/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Button from '../../components/ui/Button'
import Modal from '../../components/ui/Modal'
import { DocumentTextIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline'

const MAX_TEMPLATES = 100
const MAX_BODY_LENGTH = 1600

export default function MessageTemplates() {
  const { bulkEnabled } = useAuth()

  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Modal state (shared for create and edit)
  const [showModal, setShowModal] = useState(false)
  const [editTarget, setEditTarget] = useState(null) // null = create, object = edit
  const [modalName, setModalName] = useState('')
  const [modalBody, setModalBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState(null)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const loadTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listMessageTemplates()
      setTemplates(response.data.templates || [])
    } catch (err) {
      setError(err.message || 'Unable to load templates.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (bulkEnabled) {
      loadTemplates()
    }
  }, [bulkEnabled, loadTemplates])

  const openCreateModal = () => {
    setEditTarget(null)
    setModalName('')
    setModalBody('')
    setModalError(null)
    setShowModal(true)
  }

  const openEditModal = (template) => {
    setEditTarget(template)
    setModalName(template.name)
    setModalBody(template.body)
    setModalError(null)
    setShowModal(true)
  }

  const handleSave = async () => {
    setModalError(null)
    setSaving(true)
    try {
      if (editTarget) {
        await updateMessageTemplate({
          templateId: editTarget.templateId,
          name: modalName.trim(),
          body: modalBody,
        })
      } else {
        await createMessageTemplate({
          name: modalName.trim(),
          body: modalBody,
        })
      }
      setShowModal(false)
      setEditTarget(null)
      await loadTemplates()
    } catch (err) {
      setModalError(err.message || 'Failed to save template.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) {
      return
    }
    setDeleteError(null)
    setDeleting(true)
    try {
      await deleteMessageTemplate({ templateId: deleteTarget.templateId })
      setDeleteTarget(null)
      await loadTemplates()
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete template.')
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

  const canSave =
    modalName.trim().length > 0 &&
    modalName.trim().length <= 100 &&
    modalBody.length > 0 &&
    modalBody.length <= MAX_BODY_LENGTH

  // Segment counter for SMS messages
  const segmentCount =
    modalBody.length === 0
      ? 0
      : Math.ceil(
          modalBody.length /
            (detectIsGsm7Bit(modalBody) ? 160 : 70)
        )

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
          <h1 className="text-2xl font-bold text-gray-900">
            Message Templates
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Save reusable SMS message bodies for your campaigns.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={openCreateModal}
          disabled={templates.length >= MAX_TEMPLATES}
          title={
            templates.length >= MAX_TEMPLATES
              ? '100 template limit reached'
              : undefined
          }
        >
          New Template
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error}{' '}
          <button
            onClick={loadTemplates}
            className="ml-2 font-medium text-red-800 underline hover:text-red-900"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && templates.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-20">
          <DocumentTextIcon className="h-16 w-16 text-gray-300" />
          <h3 className="mt-4 text-lg font-medium text-gray-600">
            No templates yet.
          </h3>
          <p className="mt-2 text-sm text-gray-500">
            Create one to speed up campaign setup.
          </p>
          <Button
            variant="primary"
            className="mt-6"
            onClick={openCreateModal}
          >
            New Template
          </Button>
        </div>
      )}

      {/* Template cards */}
      {!loading && templates.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {templates.map((template) => (
            <div
              key={template.templateId}
              className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-gray-900">{template.name}</p>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => openEditModal(template)}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    title="Edit"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => {
                      setDeleteError(null)
                      setDeleteTarget(template)
                    }}
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    title="Delete"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 text-sm text-gray-500">
                {template.body.slice(0, 160)}
                {template.body.length > 160 ? '…' : ''}
              </p>
              <p className="mt-3 text-xs text-gray-400">
                Updated {formatRelativeDate(template.updatedAt)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editTarget ? 'Edit Template' : 'New Template'}
        size="xl"
      >
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Template Name
            </span>
            <input
              type="text"
              value={modalName}
              onChange={(e) => setModalName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="e.g. Weekly Sale"
              maxLength={100}
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Message Body
            </span>
            <textarea
              value={modalBody}
              onChange={(e) => {
                if (e.target.value.length <= MAX_BODY_LENGTH) {
                  setModalBody(e.target.value)
                }
              }}
              className="mt-1 min-h-[180px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="Write your SMS message here…"
              maxLength={MAX_BODY_LENGTH}
            />
            <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
              <span>
                {modalBody.length} / {MAX_BODY_LENGTH} characters
              </span>
              <span>{segmentCount} segment{segmentCount !== 1 ? 's' : ''}</span>
            </div>
          </label>

          {modalError && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {modalError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
            <Button variant="outline" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canSave || saving}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Template"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Delete &ldquo;{deleteTarget?.name}&rdquo;? This action cannot be
            undone.
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

/**
 * Detect if a string uses only GSM 7-bit characters.
 * Used to calculate SMS segment count.
 */
function detectIsGsm7Bit(str) {
  const GSM_7BIT =
    '@£$¥èéùìòÇ\\nØø\\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
  for (const ch of str) {
    if (!GSM_7BIT.includes(ch)) {
      return false
    }
  }
  return true
}
