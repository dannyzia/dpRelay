package com.digitalpapyrus.authenticator

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.telephony.SmsManager
import android.util.Log
import com.digitalpapyrus.authenticator.ratelimit.SmsRateLimiter
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Listener for pending outbound SMS jobs from Firebase RTDB.
 *
 * Watches /pending_sms/{sessionId} for new entries and sends them via SmsManager.
 * Reports delivery status back to Firebase by deleting the entry on success
 * or writing an error sub-node on failure.
 *
 * Must be started/stopped from AuthenticatorService to ensure Firebase auth is active.
 */
class PendingSmsListener(private val context: Context) {

    companion object {
        private const val TAG = "PendingSmsListener"
        private const val PENDING_SMS_PATH = "pending_sms"
        private const val SMS_TIMEOUT_MS = 60000L // 60 seconds
        private const val ACTION_SMS_SENT = "com.digitalpapyrus.authenticator.SMS_SENT"
        private const val ACTION_SMS_DELIVERED = "com.digitalpapyrus.authenticator.SMS_DELIVERED"
        private const val EXTRA_SESSION_ID = "session_id"
    }

    private val database = FirebaseDatabase.getInstance(
        "https://authenticator-15fb7-default-rtdb.asia-southeast1.firebasedatabase.app"
    )
    private val smsManager = context.getSystemService(SmsManager::class.java)
    private val smsRateLimiter = SmsRateLimiter()
    private val pendingSmsRef = database.getReference(PENDING_SMS_PATH)

    // Track active sessions for timeout handling
    private val activeSessions = ConcurrentHashMap<String, SessionTimeoutTracker>()

    private var childEventListener: ChildEventListener? = null
    private var isListening = false

    // Broadcast receivers for delivery status
    private val sentBroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID) ?: return
            when (resultCode) {
                android.app.Activity.RESULT_OK -> {
                    // SMS sent successfully - delete pending entry
                    Log.i(TAG, "SMS sent successfully for session: $sessionId")
                    activeSessions.remove(sessionId)
                    pendingSmsRef.child(sessionId).removeValue()
                        .addOnFailureListener { e ->
                            Log.e(TAG, "Failed to delete pending SMS entry: $sessionId", e)
                        }
                }
                SmsManager.RESULT_ERROR_GENERIC_FAILURE,
                SmsManager.RESULT_ERROR_NO_SERVICE,
                SmsManager.RESULT_ERROR_NULL_PDU,
                SmsManager.RESULT_ERROR_RADIO_OFF -> {
                    // SMS send failed - write error to RTDB
                    val error = getErrorString(resultCode)
                    Log.e(TAG, "SMS send failed for session $sessionId: $error")
                    activeSessions.remove(sessionId)
                    writeSendError(sessionId, "SEND_FAILED", resultCode)
                }
            }
        }
    }

    private val deliveredBroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID) ?: return
            if (resultCode == android.app.Activity.RESULT_OK) {
                Log.i(TAG, "SMS delivered for session: $sessionId")
            } else {
                Log.w(TAG, "SMS not delivered for session: $sessionId")
            }
        }
    }

    /**
     * Starts listening for pending SMS messages.
     * Must be called after Firebase authentication succeeds.
     */
    fun startListening() {
        if (isListening) {
            Log.w(TAG, "Already listening for pending SMS")
            return
        }

        Log.i(TAG, "Starting to listen for pending SMS")

        // Register broadcast receivers with RECEIVER_EXPORTED - SmsManager delivery
        // receipts come from the system process, not our own app
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(sentBroadcastReceiver, IntentFilter(ACTION_SMS_SENT), android.content.Context.RECEIVER_EXPORTED)
            context.registerReceiver(deliveredBroadcastReceiver, IntentFilter(ACTION_SMS_DELIVERED), android.content.Context.RECEIVER_EXPORTED)
        } else {
            context.registerReceiver(sentBroadcastReceiver, IntentFilter(ACTION_SMS_SENT))
            context.registerReceiver(deliveredBroadcastReceiver, IntentFilter(ACTION_SMS_DELIVERED))
        }

        childEventListener = object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                val sessionId = snapshot.key ?: return
                val data = snapshot.getValue(PendingSmsData::class.java) ?: return

                Log.i(TAG, "New pending SMS for session: $sessionId")

                // Start timeout tracker
                startTimeoutTracker(sessionId)

                // Send SMS
                sendSms(sessionId, data)
            }

            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                val sessionId = snapshot.key ?: return
                val data = snapshot.getValue(PendingSmsData::class.java)

                // If status changed back to pending (e.g., resend), send again
                if (data?.status == "pending") {
                    Log.i(TAG, "Resend requested for session: $sessionId")
                    startTimeoutTracker(sessionId)
                    sendSms(sessionId, data)
                }
            }

            override fun onChildRemoved(snapshot: DataSnapshot) {
                val sessionId = snapshot.key ?: return
                // Cancel timeout tracker
                activeSessions.remove(sessionId)
                Log.d(TAG, "Session removed: $sessionId")
            }

            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {
                Log.e(TAG, "Pending SMS listener cancelled", error.toException())
            }
        }

        pendingSmsRef.addChildEventListener(childEventListener!!)
        isListening = true
    }

    /**
     * Stops listening for pending SMS messages.
     * Should be called in AuthenticatorService.stopService().
     */
    fun stopListening() {
        if (!isListening) {
            return
        }

        Log.i(TAG, "Stopping pending SMS listener")

        childEventListener?.let {
            pendingSmsRef.removeEventListener(it)
        }

        try {
            context.unregisterReceiver(sentBroadcastReceiver)
            context.unregisterReceiver(deliveredBroadcastReceiver)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "Broadcast receivers not registered", e)
        }

        // Cancel all timeout trackers
        activeSessions.clear()

        isListening = false
    }

    /**
     * Sends an SMS using SmsManager.
     */
    private fun sendSms(sessionId: String, data: PendingSmsData) {
        val sentIntent = Intent(ACTION_SMS_SENT).apply {
            putExtra(EXTRA_SESSION_ID, sessionId)
        }

        val deliveredIntent = Intent(ACTION_SMS_DELIVERED).apply {
            putExtra(EXTRA_SESSION_ID, sessionId)
        }

        val sentPendingIntent = PendingIntent.getBroadcast(
            context,
            sessionId.hashCode(),
            sentIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT
        )

        val deliveredPendingIntent = PendingIntent.getBroadcast(
            context,
            sessionId.hashCode() + 1,
            deliveredIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT
        )

        smsRateLimiter.enqueueSms(
            data.to,
            data.message,
            sentPendingIntent,
            deliveredPendingIntent,
        ) {
            try {
                smsManager?.sendTextMessage(
                    data.to,
                    null, // serviceCenter (use default)
                    data.message,
                    sentPendingIntent,
                    deliveredPendingIntent,
                )
                Log.i(TAG, "SMS queued for sending to: ${data.to}")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to queue SMS send", e)
                activeSessions.remove(sessionId)
                writeSendError(sessionId, "QUEUE_FAILED", -1)
            }
        }
    }

    /**
     * Starts a timeout tracker for a session.
     * If the SMS is not sent within 60 seconds, writes an error.
     */
    private fun startTimeoutTracker(sessionId: String) {
        // Cancel any existing tracker for this session
        activeSessions[sessionId]?.cancel()

        val tracker = SessionTimeoutTracker(sessionId)
        activeSessions[sessionId] = tracker

        CoroutineScope(Dispatchers.IO).launch {
            delay(SMS_TIMEOUT_MS)
            if (activeSessions.containsKey(sessionId)) {
                // Timeout - SMS was not confirmed as sent
                Log.e(TAG, "SMS send timeout for session: $sessionId")
                activeSessions.remove(sessionId)
                writeSendError(sessionId, "SEND_TIMEOUT", -1)
            }
        }
    }

    /**
     * Writes a send error to the pending_sms entry.
     * Does NOT delete the entry - allows otpStatus to report the failure.
     */
    private fun writeSendError(sessionId: String, error: String, errorCode: Int) {
        val errorData = mapOf(
            "error" to error,
            "errorCode" to errorCode,
            "failedAt" to System.currentTimeMillis()
        )

        pendingSmsRef.child(sessionId).child("error").setValue(errorData)
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to write error for session: $sessionId", e)
            }
    }

    private fun getErrorString(resultCode: Int): String {
        return when (resultCode) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
            SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
            else -> "UNKNOWN_ERROR"
        }
    }

    /**
     * Data class for pending SMS entries from Firebase.
     */
    data class PendingSmsData(
        val appId: String = "",
        val to: String = "",
        val message: String = "",
        val status: String = "",
        val createdAt: Long = 0L
    )

    /**
     * Tracks a session timeout with cancellation support.
     */
    private class SessionTimeoutTracker(val sessionId: String) {
        @Volatile
        private var cancelled = false

        fun cancel() {
            cancelled = true
        }

        fun isActive(): Boolean = !cancelled
    }
}
