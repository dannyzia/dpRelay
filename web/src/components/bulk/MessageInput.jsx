import React from 'react'

const defaultPlaceholder = 'Write your SMS message here. You can use placeholders like {name} if your recipient list supports them.'

export default function MessageInput({ value, onChange }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">Message Template</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-[180px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
        placeholder={defaultPlaceholder}
      />
      <p className="mt-2 text-sm text-gray-500">
        Keep messages under 160 characters for a single segment. Personalization tokens will be substituted per recipient.
      </p>
    </label>
  )
}
