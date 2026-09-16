package com.digitalpapyrus.authenticator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.telephony.SmsMessage
import android.util.Log
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ktx.database
import com.google.firebase.ktx.Firebase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlin.math.roundToInt

/**
 * SMS receiver that filters for AUTH: prefixed messages and writes receipts to RTDB.
 * 
 * Per ADR-015 and TD-10 (pre-production blocker), this MUST normalize the originating
 * address to E.164 format before writing to RTDB. Carriers in Bangladesh frequently
 * omit the country code (e.g., "01712345678" instead of "+8801712345678").
 * 
 * Non-normalizable addresses are still written so checkAuth returns "mismatch"
 * rather than "pending" indefinitely.
 */
internal data class ParsedPaymentSms(
    val txnId: String,
    val amountPaisa: Int,
    val provider: String,
)

class SmsReceiver : BroadcastReceiver() {
    
    companion object {
        private const val TAG = "SmsReceiver"
        private const val AUTH_PREFIX = "AUTH:"
        private const val DEFAULT_COUNTRY_CODE = "+880" // Bangladesh

        private val BKASH_SENDERS = setOf("bKash", "BKASH", "16247")
        private val NAGAD_SENDERS = setOf("Nagad", "NAGAD", "16167")

        fun isPaymentSms(sender: String): Boolean =
            sender in BKASH_SENDERS || sender in NAGAD_SENDERS
    }
    
    private val receiverScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var database: FirebaseDatabase
    
    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (intent.action == "android.provider.Telephony.SMS_RECEIVED") {
                database = Firebase.database
                
                val bundle = intent.extras ?: return
                val pdus = bundle.get("pdus") as Array<ByteArray>? ?: return
                
                for (pdu in pdus) {
                    val format = bundle.getString("format")
                    val smsMessage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        SmsMessage.createFromPdu(pdu, format)
                    } else {
                        @Suppress("DEPRECATION")
                        SmsMessage.createFromPdu(pdu)
                    }
                    
                    smsMessage?.let { processSms(context, it) }
                }
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException in SMS processing - permission denied", e)
        } catch (e: NullPointerException) {
            Log.e(TAG, "NullPointerException in SMS processing", e)
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected exception in SMS processing", e)
        }
    }
    
    private fun processSms(context: Context, smsMessage: SmsMessage) {
        val messageBody = smsMessage.messageBody
        val originatingAddress = smsMessage.originatingAddress ?: ""

        if (isPaymentSms(originatingAddress)) {
            val parsedPaymentSms = parsePaymentSms(originatingAddress, messageBody)
            if (parsedPaymentSms == null) {
                Log.w(
                    TAG,
                    "payment SMS parse failed — no TxID or amount. sender=$originatingAddress",
                )
                return
            }

            Log.i(
                TAG,
                "payment SMS parsed: provider=${parsedPaymentSms.provider} " +
                    "txn_id_length=${parsedPaymentSms.txnId.length} " +
                    "amount_paisa=${parsedPaymentSms.amountPaisa}",
            )

            handlePaymentSms(context, originatingAddress, parsedPaymentSms)
            return
        }

        // Filter by AUTH: prefix (case-insensitive)
        if (!messageBody.startsWith(AUTH_PREFIX, ignoreCase = true)) {
            // Silently discard non-AUTH messages - do not log body
            return
        }

        // Parse the AUTH: payload
        val parts = messageBody.substring(AUTH_PREFIX.length).split(":")
        if (parts.size != 3) {
            Log.w(TAG, "Invalid AUTH payload format")
            return
        }

        val sessionCode = parts[0]
        val expiresAt = parts[1].toLongOrNull()
        val challengeToken = parts[2]

        if (expiresAt == null) {
            Log.w(TAG, "Invalid expiresAt in payload")
            return
        }

        // Validate expiry (reject obviously expired messages)
        if (AuthCrypto.isExpired(expiresAt)) {
            Log.w(TAG, "SMS expired")
            return
        }

        // Normalize originating address to E.164 (ADR-015, TD-10)
        val normalizedSender = normalizeToE164(originatingAddress)

        // Write receipt to RTDB
        writeReceipt(context, sessionCode, normalizedSender, challengeToken)
    }
    
    /**
     * Normalizes a raw SMS originating address to E.164 for Bangladesh numbers.
     * 
     * Per ADR-015, this is critical for preventing silent "mismatch" failures.
     * 
     * Rules:
     * - "+8801XXXXXXXXX" → unchanged
     * - "8801XXXXXXXXX" → "+8801XXXXXXXXX"
     * - "01XXXXXXXXX" → "+8801XXXXXXXXX"
     * - anything else → return as-is (produces mismatch, not pending)
     * 
     * @param raw The raw originating address from the carrier
     * @return Normalized E.164 address or original if unrecognizable
     */
    fun normalizeToE164(raw: String, defaultCountryCode: String = DEFAULT_COUNTRY_CODE): String {
        // Check for invalid characters (non-digits except leading +)
        val digitsOnly = raw.replace(Regex("[^0-9]"), "")
        if (digitsOnly.length != raw.length && !raw.startsWith("+")) {
            // Contains non-digits and doesn't start with + - unrecognizable
            return raw
        }

        if (raw.startsWith("+")) {
            return raw
        }

        if (raw.startsWith("880")) {
            return "+$raw"
        }

        if (raw.startsWith("0")) {
            return "$defaultCountryCode${raw.substring(1)}"
        }

        // Unrecognizable format - return as-is so checkAuth returns mismatch
        return raw
    }

    internal fun parsePaymentSms(sender: String, body: String): ParsedPaymentSms? {
        val txnId = Regex("\\b[A-Z0-9]{10}\\b").find(body)?.value ?: return null
        val amountMatch = Regex("Tk (\\d+(?:\\.\\d{1,2})?)").find(body) ?: return null
        val amountStr = amountMatch.groupValues[1]
        val amountPaisa = (amountStr.toDouble() * 100).roundToInt()

        val provider = if (sender in BKASH_SENDERS) {
            "bkash"
        } else {
            "nagad"
        }

        return ParsedPaymentSms(txnId = txnId, amountPaisa = amountPaisa, provider = provider)
    }

    private fun handlePaymentSms(context: Context, sender: String, parsed: ParsedPaymentSms) {
        receiverScope.launch {
            try {
                // v5 parallel run (M2, PLAN §7 #6): post to the REST ingest first.
                // Server is idempotent per unique txn_id, so retries never double-count.
                if (V5ApiClient.isEnabled() && EncryptedPrefsHelper.getDeviceApiKey(context.applicationContext) != null) {
                    val posted = V5ApiClient.postPaymentSms(
                        context.applicationContext,
                        sender = sender,
                        provider = parsed.provider,
                        txnId = parsed.txnId,
                        amountPaisa = parsed.amountPaisa,
                        receivedAtMs = System.currentTimeMillis(),
                    )
                    Log.i(TAG, "payment_sms v5 post: ok=$posted")
                }

                val payload = mapOf(
                    "txn_id" to parsed.txnId,
                    "amount_bdt" to parsed.amountPaisa,
                    "provider" to parsed.provider,
                    "sender" to sender,
                    "received_at" to com.google.firebase.database.ServerValue.TIMESTAMP,
                )

                database.getReference("payment_sms")
                    .push()
                    .setValue(payload)
                    .await()
            } catch (e: Exception) {
                Log.e("SmsReceiver", "payment_sms RTDB write failed: ${e.message}")
            }
        }
    }

    private fun writeReceipt(
        context: Context,
        sessionCode: String,
        sender: String,
        challengeToken: String
    ) {
        receiverScope.launch {
            try {
                val device = android.os.Build.MODEL
                
                val receiptData = mapOf(
                    "receivedAt" to com.google.firebase.database.ServerValue.TIMESTAMP,
                    "sender" to sender,
                    "challengeToken" to challengeToken,
                    "device" to device
                )
                
                database.getReference("verification_requests")
                    .child(sessionCode)
                    .child("receipt")
                    .setValue(receiptData)
                    .await()
                
                Log.i(TAG, "Receipt written for session $sessionCode")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to write receipt", e)
                // Firebase SDK will queue offline writes and sync on reconnect
            }
        }
    }
}
