package com.digitalpapyrus.dprelay.reader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsMessage
import android.util.Log

/**
 * The reader's only data source: SMS_RECEIVED broadcasts filtered to the
 * configured payment senders (classification is sender-only — body content is
 * parsed only AFTER the sender matches).
 *
 * On a parse failure the SMS is ignored-with-log (Log.w, sender + reason
 * only) — never uploaded, never retried: there is nothing to retry with.
 *
 * Logging rules (project-wide): Log.i/w/e only; never the SMS body; never the
 * full TrxID (its LENGTH only) — a payment TrxID in logcat is a privacy leak.
 */
class PaymentSmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_SMS_RECEIVED) return
        val bundle = intent.extras ?: return
        val pdus = bundle.get(EXTRA_PDUS) as Array<ByteArray>? ?: return
        for (pdu in pdus) {
            val format = bundle.getString(EXTRA_FORMAT)
            val message = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                SmsMessage.createFromPdu(pdu, format)
            } else {
                @Suppress("DEPRECATION")
                SmsMessage.createFromPdu(pdu)
            } ?: continue
            handle(context, message.originatingAddress ?: "", message.messageBody ?: "")
        }
    }

    /** Parses one payment SMS and queues it for upload. */
    private fun handle(context: Context, sender: String, body: String) {
        if (!PaymentParser.isPaymentSms(sender)) return

        val parsed = PaymentParser.parse(sender, body)
        if (parsed == null) {
            // Malformed payment SMS: ignored-with-log (AC). Sender here is a
            // payment shortcode — safe to log; the body never is.
            Log.w(TAG, "payment SMS ignored — no TrxID or amount (sender=$sender)")
            return
        }

        Log.i(
            TAG,
            "payment SMS parsed: provider=${parsed.provider} " +
                "txn_id_length=${parsed.txnId.length} amount_paisa=${parsed.amountPaisa}",
        )

        val queue = UploadQueue(PrefsQueueStore(context)) { System.currentTimeMillis() }
        queue.enqueue(PendingUpload.from(sender, parsed, body, System.currentTimeMillis()))
        // Kick the uploader: it drains now-due items and re-schedules itself
        // with backoff until the queue is empty (or config is missing).
        UploadWorker.schedule(context)
    }

    companion object {
        private const val TAG = "PaymentSmsReceiver"
        private const val ACTION_SMS_RECEIVED = "android.provider.Telephony.SMS_RECEIVED"
        private const val EXTRA_PDUS = "pdus"
        private const val EXTRA_FORMAT = "format"
    }
}
