package com.digitalpapyrus.authenticator

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.telephony.SmsManager
import android.util.Log
import com.digitalpapyrus.authenticator.ratelimit.SmsRateLimiter
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Pull-based fetcher for outbound SMS from the v5 server (M2, PLAN §7 #2).
 *
 * Triggered by FCM wake-ups and after each heartbeat, it claims pending
 * messages from GET /v5/device/outstanding, sends them through the existing
 * SmsRateLimiter pipeline, and reports terminal results via
 * POST /v5/device/results. The server-side claim + requeue window provides
 * at-least-once delivery: a claim that is never confirmed expires and is
 * re-offered, so no message can be silently dropped — and because staleness
 * is decided server-side, an offline backlog cannot burst-send on reconnect.
 *
 * A process-wide singleton (object): FCM service instances are ephemeral, and
 * broadcast receivers must be registered exactly once per process. Deliberately
 * STANDALONE from the legacy PendingSmsListener (parallel run, PLAN §9) — the
 * Firebase plane keeps operating untouched; a v5-path bug can never take it down.
 */
object OutstandingFetcher {

    private const val TAG = "OutstandingFetcher"
    private const val SMS_TIMEOUT_MS = 60_000L
    private const val ACTION_SMS_SENT = "com.digitalpapyrus.authenticator.V5_SMS_SENT"
    private const val ACTION_SMS_DELIVERED = "com.digitalpapyrus.authenticator.V5_SMS_DELIVERED"
    private const val EXTRA_MESSAGE_ID = "message_id"

    private val fetchScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val smsRateLimiter = SmsRateLimiter

    // messageId → started-at for sends not yet confirmed by the sent broadcast.
    private val inFlight = ConcurrentHashMap<String, Long>()

    @Volatile
    private var receiversRegistered = false

    private val sentBroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context?, intent: Intent?) {
            val messageId = intent?.getStringExtra(EXTRA_MESSAGE_ID) ?: return
            val resultCode = resultCode
            inFlight.remove(messageId)
            when (resultCode) {
                android.app.Activity.RESULT_OK -> reportResult(messageId, "sent", null)
                SmsManager.RESULT_ERROR_GENERIC_FAILURE,
                SmsManager.RESULT_ERROR_NO_SERVICE,
                SmsManager.RESULT_ERROR_NULL_PDU,
                SmsManager.RESULT_ERROR_RADIO_OFF,
                -> reportResult(messageId, "failed", resultCodeToString(resultCode))
                else -> reportResult(messageId, "failed", "UNKNOWN_ERROR")
            }
        }
    }

    private val deliveredBroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context?, intent: Intent?) {
            // Delivery confirmation is informational in M2; the M3 events plane
            // (webhook inversion) is where delivery reports become actionable.
            val messageId = intent?.getStringExtra(EXTRA_MESSAGE_ID)
            Log.i(TAG, "v5 delivery broadcast for $messageId: resultCode=$resultCode")
        }
    }

    /**
     * Claims and sends everything currently outstanding. Safe to call from any
     * component (FCM service, service heartbeat loop); concurrent calls are
     * deduplicated per message id.
     */
    fun fetchAndSend(appContext: Context) {
        if (!V5ApiClient.isEnabled()) return
        fetchScope.launch {
            val context = appContext.applicationContext
            if (EncryptedPrefsHelper.getDeviceApiKey(context) == null) {
                // Not enrolled yet; enrollment happens in AuthenticatorService.
                return@launch
            }

            registerReceiversOnce(context)
            val messages = V5ApiClient.fetchOutstanding(context) ?: return@launch
            if (messages.isEmpty()) {
                Log.i(TAG, "v5 outstanding: nothing to send")
                return@launch
            }
            Log.i(TAG, "v5 outstanding: claimed ${messages.size} message(s)")
            for (message in messages) {
                enqueueSend(context, message)
            }
        }
    }

    private fun enqueueSend(context: Context, message: V5OutstandingMessage) {
        if (inFlight.containsKey(message.id)) {
            // Server requeue raced with a still-in-flight send; skip the duplicate.
            Log.w(TAG, "duplicate claim ignored for ${message.id}")
            return
        }

        val sentIntent = Intent(ACTION_SMS_SENT).apply { putExtra(EXTRA_MESSAGE_ID, message.id) }
        val deliveredIntent = Intent(ACTION_SMS_DELIVERED).apply { putExtra(EXTRA_MESSAGE_ID, message.id) }
        val sentPendingIntent = PendingIntent.getBroadcast(
            context,
            message.id.hashCode(),
            sentIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
        )
        val deliveredPendingIntent = PendingIntent.getBroadcast(
            context,
            message.id.hashCode() + 1,
            deliveredIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
        )

        val smsManager = context.getSystemService(SmsManager::class.java)
        inFlight[message.id] = System.currentTimeMillis()
        startTimeoutTracker(message.id)

        smsRateLimiter.enqueueSms(
            message.to,
            message.message,
            sentPendingIntent,
            deliveredPendingIntent,
        ) {
            try {
                smsManager?.sendTextMessage(
                    message.to,
                    null,
                    message.message,
                    sentPendingIntent,
                    deliveredPendingIntent,
                )
                Log.i(TAG, "v5 SMS queued to ${message.to}")
            } catch (e: Exception) {
                Log.e(TAG, "v5 SMS queue failed for ${message.id}", e)
                inFlight.remove(message.id)
                reportResult(message.id, "failed", "QUEUE_FAILED")
            }
        }
    }

    /** Reports a terminal result; failures rely on the server requeue window. */
    private fun reportResult(messageId: String, status: String, error: String?) {
        fetchScope.launch {
            val ok = V5ApiClient.postResults(
                applicationContext(),
                listOf(V5MessageResult(id = messageId, status = status, error = error)),
            )
            if (ok) {
                Log.i(TAG, "v5 result reported: $messageId → $status")
            } else {
                // The server's requeue window will re-offer the message; a later
                // duplicate result lands as an accounted "unknown" server-side.
                Log.e(TAG, "v5 result report failed for $messageId (server will requeue)")
            }
        }
    }

    private fun startTimeoutTracker(messageId: String) {
        fetchScope.launch {
            kotlinx.coroutines.delay(SMS_TIMEOUT_MS)
            if (inFlight.remove(messageId) != null) {
                Log.e(TAG, "v5 SMS send timeout for $messageId")
                reportResult(messageId, "failed", "SEND_TIMEOUT")
            }
        }
    }

    private fun resultCodeToString(resultCode: Int): String =
        when (resultCode) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
            SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
            else -> "UNKNOWN_ERROR"
        }

    /**
     * The fetcher must work from ephemeral FCM service instances, where no
     * caller-scoped context survives; the application context is the only
     * durable handle. Captured on first registration.
     */
    @Volatile
    private var appContextRef: Context? = null

    private fun applicationContext(): Context = appContextRef
        ?: error("OutstandingFetcher not initialized — call fetchAndSend() first")

    /** Idempotent registration — SmsManager receipts come from the system process. */
    private fun registerReceiversOnce(context: Context) {
        if (receiversRegistered) return
        synchronized(this) {
            if (receiversRegistered) return
            appContextRef = context
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(
                    sentBroadcastReceiver,
                    IntentFilter(ACTION_SMS_SENT),
                    android.content.Context.RECEIVER_EXPORTED,
                )
                context.registerReceiver(
                    deliveredBroadcastReceiver,
                    IntentFilter(ACTION_SMS_DELIVERED),
                    android.content.Context.RECEIVER_EXPORTED,
                )
            } else {
                context.registerReceiver(sentBroadcastReceiver, IntentFilter(ACTION_SMS_SENT))
                context.registerReceiver(deliveredBroadcastReceiver, IntentFilter(ACTION_SMS_DELIVERED))
            }
            receiversRegistered = true
        }
    }
}
