package com.digitalpapyrus.authenticator.ratelimit

import android.app.PendingIntent
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicLong

/**
 * Process-wide SMS rate limiter.
 *
 * A SINGLE instance must serve every outbound SMS path on the phone. During the
 * dual-plane run (PLAN §9) the legacy PendingSmsListener (RTDB plane) and the v5
 * OutstandingFetcher (v5 device plane) both feed the same SmsManager, and a
 * per-plane limiter would let the two planes race each other into the Android
 * "too many SMS" dialog. As an [object], every caller shares one queue, one
 * handler thread, one inter-send interval — the phone's send rate is governed
 * once, regardless of which plane sourced the message.
 */
object SmsRateLimiter {

    private const val MIN_INTERVAL_MS = 5000L

    private data class SendRequest(
        val destination: String,
        val text: String,
        val sentIntent: PendingIntent,
        val deliveryIntent: PendingIntent,
        val sendAction: () -> Unit,
    )

    private val queue = ConcurrentLinkedQueue<SendRequest>()
    private val lastSendTimestamp = AtomicLong(0L)
    private val handlerThread = HandlerThread("SmsRateLimiterThread").apply { start() }
    private val handler = Handler(handlerThread.looper)

    fun enqueueSms(
        destination: String,
        text: String,
        sentIntent: PendingIntent,
        deliveryIntent: PendingIntent,
        sendAction: () -> Unit,
    ) {
        val request = SendRequest(destination, text, sentIntent, deliveryIntent, sendAction)
        queue.add(request)
        scheduleNextSend(0)
    }

    fun getQueueDepth(): Int = queue.size

    fun getEstimatedWaitMs(): Long {
        val now = SystemClock.elapsedRealtime()
        val lastSentAt = lastSendTimestamp.get()
        val baseDelay = if (lastSentAt == 0L) 0L else maxOf(0L, MIN_INTERVAL_MS - (now - lastSentAt))
        return baseDelay + (queue.size.toLong() - 1).coerceAtLeast(0L) * MIN_INTERVAL_MS
    }

    private fun scheduleNextSend(delayMs: Long) {
        handler.removeCallbacks(processQueueRunnable)
        handler.postDelayed(processQueueRunnable, delayMs)
    }

    private val processQueueRunnable = Runnable {
        val request = queue.peek() ?: return@Runnable
        val now = SystemClock.elapsedRealtime()
        val nextAllowedAt = lastSendTimestamp.get() + MIN_INTERVAL_MS
        val delay = maxOf(0L, nextAllowedAt - now)

        if (delay > 0) {
            scheduleNextSend(delay)
            return@Runnable
        }

        val nextRequest = queue.poll() ?: return@Runnable
        lastSendTimestamp.set(SystemClock.elapsedRealtime())

        try {
            nextRequest.sendAction()
        } catch (_: Exception) {
            // The caller's sendAction should handle error reporting.
        }

        scheduleNextSend(MIN_INTERVAL_MS)
    }
}
