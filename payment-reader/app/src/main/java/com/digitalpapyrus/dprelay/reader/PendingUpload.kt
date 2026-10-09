package com.digitalpapyrus.dprelay.reader

/**
 * One parsed payment waiting to reach the server. Items persist in
 * app-private storage (see PrefsQueueStore) so an offline money phone keeps
 * every payment until it lands; the server's unique-TrxID INSERT OR IGNORE
 * makes a duplicate upload an idempotent no-op, so retrying is always safe.
 *
 * `rawBody` rides along per the F8 payload spec. It is app-private local
 * data, never logged, and the server accepts-but-never-stores it (parity
 * only) — SMS body text never reaches the database.
 *
 * @property id queue identity (uuid), independent of trxId.
 * @property attempts failed upload attempts so far (drives backoff).
 * @property nextAttemptAtMs epoch ms before which the item is not due.
 */
data class PendingUpload(
    val id: String,
    val sender: String,
    val provider: String,
    val trxId: String,
    val amountBdt: Double,
    val receivedAtMs: Long,
    val rawBody: String,
    val attempts: Int = 0,
    val nextAttemptAtMs: Long = 0L,
) {
    companion object {

        /**
         * Builds an item that is due immediately. `amountBdt` is derived from
         * the parsed paisa amount (exact 2-decimal round-trip through the
         * server's `Math.round(amountBdt * 100)` back to the same paisa).
         *
         * @param sender originating address (a payment sender — checked upstream).
         * @param parsed parser output for this SMS.
         * @param rawBody raw SMS body, retained only for the spec payload.
         * @param nowMs epoch ms of receipt (injected clock, never read inline).
         */
        fun from(
            sender: String,
            parsed: ParsedPaymentSms,
            rawBody: String,
            nowMs: Long,
        ): PendingUpload =
            PendingUpload(
                id = java.util.UUID.randomUUID().toString(),
                sender = sender,
                provider = parsed.provider,
                trxId = parsed.txnId,
                amountBdt = parsed.amountPaisa / 100.0,
                receivedAtMs = nowMs,
                rawBody = rawBody,
                nextAttemptAtMs = nowMs,
            )
    }
}

/**
 * Line-oriented persistence codec for the upload queue.
 *
 * Deliberately NOT org.json: that class is Android-framework-only and unit
 * tests run on the JVM, so the queue's durability contract is exercised
 * here with plain Kotlin. Format: one item per line, fields tab-separated,
 * with `\t`/`\n`/`\r`/`\\` backslash-escaped inside fields. A corrupt line is
 * dropped on decode (better one lost line than a wedged queue).
 */
object QueueCodec {

    private const val FIELD_SEP = '\t'
    private const val LINE_SEP = '\n'
    private const val FIELD_COUNT = 9

    fun encode(items: List<PendingUpload>): String =
        items.joinToString(separator = LINE_SEP.toString()) { encodeItem(it) }

    fun decode(raw: String): List<PendingUpload> =
        if (raw.isEmpty()) {
            emptyList()
        } else {
            raw.split(LINE_SEP).filter { it.isNotEmpty() }.mapNotNull { decodeItem(it) }
        }

    private fun encodeItem(item: PendingUpload): String =
        listOf(
            item.id,
            item.sender,
            item.provider,
            item.trxId,
            item.amountBdt.toString(),
            item.receivedAtMs.toString(),
            item.rawBody,
            item.attempts.toString(),
            item.nextAttemptAtMs.toString(),
        )
            .joinToString(separator = FIELD_SEP.toString()) { escapeField(it) }

    private fun decodeItem(line: String): PendingUpload? {
        val fields = line.split(FIELD_SEP).map { unescapeField(it) }
        if (fields.size != FIELD_COUNT) return null
        val amount = fields[4].toDoubleOrNull() ?: return null
        val receivedAt = fields[5].toLongOrNull() ?: return null
        val attempts = fields[7].toIntOrNull() ?: return null
        val nextAttemptAt = fields[8].toLongOrNull() ?: return null
        return PendingUpload(
            id = fields[0],
            sender = fields[1],
            provider = fields[2],
            trxId = fields[3],
            amountBdt = amount,
            receivedAtMs = receivedAt,
            rawBody = fields[6],
            attempts = attempts,
            nextAttemptAtMs = nextAttemptAt,
        )
    }

    private fun escapeField(value: String): String =
        buildString {
            for (ch in value) {
                when (ch) {
                    '\\' -> append("\\\\")
                    '\t' -> append("\\t")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    else -> append(ch)
                }
            }
        }

    private fun unescapeField(value: String): String =
        buildString {
            var i = 0
            while (i < value.length) {
                val ch = value[i]
                if (ch == '\\' && i + 1 < value.length) {
                    when (value[i + 1]) {
                        't' -> append('\t')
                        'n' -> append('\n')
                        'r' -> append('\r')
                        '\\' -> append('\\')
                        else -> append(ch)
                    }
                    i += 2
                } else {
                    append(ch)
                    i += 1
                }
            }
        }
}
