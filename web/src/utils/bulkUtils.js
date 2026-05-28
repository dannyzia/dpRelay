const GSM_BASIC_CHARS = new Set(
  "@£$¥èéùìòÇ\nØøÅåΔ_ΦΓΛΩΠΨΣΘΞ\r!\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà "
)
const GSM_EXTENDED_CHARS = new Set('^{}\\[~]|€')
const MAX_ROWS = 10000
const HEADER_MATCH = /^(phone|phone_number|mobile|msisdn)$/i

export function parseCsvPhones(raw) {
  const content = raw || ''
  let lines = content
    .split(/\r?\n|,|;/)
    .map((line) => line.trim())
    .filter((value) => value.length > 0)

  const hasHeader = lines.length > 0 && HEADER_MATCH.test(lines[0].replace(/['"]/g, '').trim())
  if (hasHeader) {
    lines = lines.slice(1)
  }

  const originalCount = lines.length
  const truncatedCount = originalCount > MAX_ROWS ? originalCount - MAX_ROWS : 0
  if (originalCount > MAX_ROWS) {
    lines = lines.slice(0, MAX_ROWS)
  }

  const rows = []
  const seen = new Set()

  lines.forEach((value) => {
    const normalized = value.trim()
    const valid = isE164(normalized)
    const duplicate = seen.has(normalized)
    if (!duplicate) {
      seen.add(normalized)
    }
    rows.push({
      phone: normalized,
      valid,
      duplicate,
      reason: duplicate ? 'Duplicate' : valid ? null : 'Invalid format',
    })
  })

  return {
    rows,
    validPhones: [...new Set(rows.filter((row) => row.valid).map((row) => row.phone))],
    invalidCount: rows.filter((row) => !row.valid).length,
    duplicateCount: rows.filter((row) => row.duplicate).length,
    totalCount: rows.length,
    originalCount,
    truncatedCount,
    hasHeader,
  }
}

export function isE164(value) {
  return /^\+[1-9]\d{1,14}$/.test(value)
}

export function detectCharset(text) {
  if (!text || typeof text !== 'string') {
    return 'GSM'
  }

  for (const char of text) {
    if (GSM_BASIC_CHARS.has(char)) {
      continue
    }
    if (GSM_EXTENDED_CHARS.has(char)) {
      continue
    }
    return 'UCS-2'
  }

  return 'GSM'
}

export function estimateSegments(text) {
  const charset = detectCharset(text)
  const length = text.length
  if (charset === 'GSM') {
    if (length <= 160) return 1
    return Math.ceil((length - 160) / 153) + 1
  }
  if (length <= 70) return 1
  return Math.ceil((length - 70) / 67) + 1
}
