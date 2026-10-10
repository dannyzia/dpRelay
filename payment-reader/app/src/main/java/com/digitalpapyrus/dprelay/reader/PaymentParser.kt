package com.digitalpapyrus.dprelay.reader

import kotlin.math.roundToInt

/**
 * Parsed payment-SMS fields — same shape the gateway's SmsReceiver produces
 * (parser parity is asserted by the mirrored unit-test fixtures).
 *
 * @property txnId 10-char uppercase alphanumeric TrxID (server TXN_ID_PATTERN).
 * @property amountPaisa integer paisa, e.g. 50000 for Tk 500.00.
 * @property provider "bkash" or "nagad", derived from the sender.
 */
data class ParsedPaymentSms(
    val txnId: String,
    val amountPaisa: Int,
    val provider: String,
)

/**
 * Pure bKash/Nagad classification + parsing. No Android types — unit-testable
 * on the JVM and shared by design with the gateway parser
 * (authenticator-app SmsReceiver) and the server's ingest validation:
 * the same two regexes, the same fixtures, so a change to any one of the
 * three must be mirrored in the others.
 */
object PaymentParser {

    /**
     * THE sender list (AC: configurable in one constant). Carriers render the
     * sender differently per handset — both label and shortcode variants are
     * recognised, mirroring the gateway's BKASH_SENDERS/NAGAD_SENDERS.
     */
    private val BKASH_SENDERS = setOf("bKash", "BKASH", "16247")
    private val NAGAD_SENDERS = setOf("Nagad", "NAGAD", "16167")

    /** Sender-only classification — body content is never sniffed for this. */
    fun isPaymentSms(sender: String): Boolean = sender in BKASH_SENDERS || sender in NAGAD_SENDERS

    /**
     * Extracts TrxID (first \b[A-Z0-9]{10}\b) and amount (first `Tk N(.NN)?`)
     * from a confirmation body. Returns null when either is missing or the
     * sender is not a known payment sender — the caller logs and drops it
     * (malformed SMS is ignored-with-log, never uploaded).
     *
     * @param sender originating address as delivered by the carrier.
     * @param body raw SMS body — parsed, never logged.
     */
    fun parse(sender: String, body: String): ParsedPaymentSms? {
        if (!isPaymentSms(sender)) return null
        val txnId = TXN_ID_REGEX.find(body)?.value ?: return null
        val amountMatch = AMOUNT_REGEX.find(body) ?: return null
        val amountPaisa = (amountMatch.groupValues[1].toDouble() * 100).roundToInt()
        val provider = if (sender in BKASH_SENDERS) "bkash" else "nagad"
        return ParsedPaymentSms(txnId = txnId, amountPaisa = amountPaisa, provider = provider)
    }

    /** Same acceptance set as the server's `^[A-Z0-9]{10}$` TrxID rule. */
    private val TXN_ID_REGEX = Regex("\\b[A-Z0-9]{10}\\b")

    /** Tolerant amount extraction — covers every known bKash/Nagad format. */
    private val AMOUNT_REGEX = Regex("Tk (\\d+(?:\\.\\d{1,2})?)")
}
