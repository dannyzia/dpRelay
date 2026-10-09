package com.digitalpapyrus.dprelay.reader

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Drains the offline upload queue (STAGE F8).
 *
 * Runs on a WorkManager background thread; classifies each outcome:
 * - Accepted → item leaves the queue;
 * - Rejected (server 400) → item is dropped with an ERROR log — retrying a
 *   payload the server will never accept is pointless, and the log makes the
 *   loss visible instead of silent;
 * - Failed (network/5xx/401/403…) → backoff, item stays queued, worker
 *   re-schedules itself while ANY item remains — a misconfigured secret never
 *   discards a payment, the operator fixes it and the queue drains.
 */
class UploadWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        val config = ReaderConfig(applicationContext)
        if (!config.isConfigured()) {
            // Not an error: items stay queued until onboarding completes
            // (MainActivity schedules a fresh run after a successful save).
            Log.w(TAG, "upload skipped — reader not configured yet")
            return Result.success()
        }

        val queue = UploadQueue(PrefsQueueStore(applicationContext)) { System.currentTimeMillis() }
        var transientFailure = false

        for (item in queue.dueItems()) {
            val outcome = PaymentApiClient.send(config.serverUrl(), config.readerSecret(), item)
            when (outcome) {
                is PaymentApiClient.Outcome.Accepted -> {
                    queue.remove(item.id)
                    Log.i(TAG, "payment uploaded: trx_id_length=${item.trxId.length}")
                }
                is PaymentApiClient.Outcome.Rejected -> {
                    queue.remove(item.id)
                    Log.e(
                        TAG,
                        "payment rejected by server (400) — dropped, " +
                            "trx_id_length=${item.trxId.length}",
                    )
                }
                is PaymentApiClient.Outcome.Failed -> {
                    queue.markFailed(item.id)
                    transientFailure = true
                    Log.w(TAG, "payment upload failed (${outcome.detail}) — retry with backoff")
                }
            }
        }

        // Retry while anything is still waiting (due now or backing off) —
        // WorkManager's own exponential backoff paces these re-runs.
        val stillWaiting = transientFailure || queue.pendingCount() > 0
        return if (stillWaiting) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "UploadWorker"
        private const val UNIQUE_WORK = "payment-reader-upload"

        /**
         * Schedules a queue drain. REPLACE is safe: an interrupted upload is
         * re-sent later and the server dedupes on the unique TrxID, so there
         * is no double-count risk — only idempotent retries.
         */
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    UploadQueue.BASE_BACKOFF_MS,
                    TimeUnit.MILLISECONDS,
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
