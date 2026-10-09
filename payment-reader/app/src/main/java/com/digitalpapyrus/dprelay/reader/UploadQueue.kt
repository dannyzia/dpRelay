package com.digitalpapyrus.dprelay.reader

/**
 * Persistence boundary for the upload queue — lets the queue's semantics
 * (dedupe, backoff, durability) be unit-tested on the JVM without Android.
 */
interface QueueStore {

    /** Returns the encoded queue ("" when nothing is queued). */
    fun read(): String

    /** Replaces the encoded queue. Must be durable before returning (money data). */
    fun write(payload: String)
}

/**
 * Offline upload queue with exponential backoff.
 *
 * Invariants:
 * - dedupe by TrxID: a re-parsed duplicate payment never joins twice (and the
 *   server's unique-`txn_id` INSERT OR IGNORE is the second line of defence);
 * - `dueItems()` gates retries on the injected clock — tests never read real time;
 * - a failed upload grows `attempts` and schedules the next attempt at
 *   `now + backoff(attempts)`, capped at [MAX_BACKOFF_MS];
 * - items are only removed by [remove] (accepted by the server, or dropped as
 *   permanently invalid there) — there is NO attempt cap, because dropping an
 *   unpaid-but-real payment is worse than retrying forever at a 30-min cadence.
 *
 * @param store durability boundary (plain app-private prefs in production).
 * @param nowMs injected clock (epoch ms).
 */
class UploadQueue(
    private val store: QueueStore,
    private val nowMs: () -> Long,
) {

    private fun load(): MutableList<PendingUpload> = QueueCodec.decode(store.read()).toMutableList()

    private fun save(items: List<PendingUpload>) = store.write(QueueCodec.encode(items))

    /**
     * Queues an item unless its TrxID is already waiting. Returns true when
     * the queue changed.
     */
    fun enqueue(item: PendingUpload): Boolean {
        val items = load()
        if (items.any { it.trxId == item.trxId }) return false
        items.add(item)
        save(items)
        return true
    }

    /** Items whose backoff window has elapsed (fresh items are due immediately). */
    fun dueItems(): List<PendingUpload> {
        val now = nowMs()
        return load().filter { it.nextAttemptAtMs <= now }
    }

    /** Items left in the queue (any reason — drives "retry while non-empty"). */
    fun pendingCount(): Int = load().size

    /** Removes an item: it left the queue for good (uploaded, or rejected upstream). */
    fun remove(id: String) = save(load().filterNot { it.id == id })

    /** Records a failed attempt: attempts+1 and next attempt at now+backoff. */
    fun markFailed(id: String) {
        val items = load()
        val index = items.indexOfFirst { it.id == id }
        if (index < 0) return
        val current = items[index]
        val attempts = current.attempts + 1
        items[index] = current.copy(
            attempts = attempts,
            nextAttemptAtMs = nowMs() + backoffMs(attempts),
        )
        save(items)
    }

    companion object {

        /** First retry after 30s; doubles per attempt (offline money phone → fast recovery). */
        const val BASE_BACKOFF_MS = 30_000L

        /** Ceiling: retry cadence settles at 30 minutes per item. */
        const val MAX_BACKOFF_MS = 30L * 60_000L

        /**
         * Exponential backoff for the given (1-based) failed-attempt count:
         * 30s, 60s, 120s … capped at [MAX_BACKOFF_MS].
         */
        fun backoffMs(attempt: Int): Long {
            if (attempt <= 1) return BASE_BACKOFF_MS
            // shift ≤ 30 keeps the multiplication far from Long overflow;
            // the cap clamps long before that anyway (attempt ≥ 7).
            val shift = (attempt - 1).coerceAtMost(30)
            return (BASE_BACKOFF_MS shl shift).coerceAtMost(MAX_BACKOFF_MS)
        }
    }
}
