package com.digitalpapyrus.dprelay.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Retry-queue semantics (F8 AC: "offline queue — unsent items persist locally
 * and retry with backoff", "TrxID dedupe"). Everything runs against an
 * in-memory store and a fixed clock — no real time, no Android framework.
 */
class UploadQueueTest {

    /** In-memory [QueueStore] — durability is asserted by re-reading. */
    private class MemoryStore : QueueStore {
        var payload: String = ""
            private set

        override fun read(): String = payload

        override fun write(payload: String) {
            this.payload = payload
        }

        /** Test hook: append raw bytes to simulate on-disk corruption. */
        fun appendRaw(raw: String) {
            payload += raw
        }
    }

    private var now = 1_760_000_000_000L
    private val store = MemoryStore()
    private val queue = UploadQueue(store) { now }

    private fun item(
        trxId: String = "8AC3K2L9P1",
        rawBody: String = "TrxID $trxId. Tk 500.00 paid.",
    ): PendingUpload =
        PendingUpload.from(
            sender = "16247",
            parsed = ParsedPaymentSms(txnId = trxId, amountPaisa = 50000, provider = "bkash"),
            rawBody = rawBody,
            nowMs = now,
        )

    @Test
    fun `enqueue makes the item due immediately and it survives a new queue instance`() {
        assertTrue(queue.enqueue(item()))

        // Durability: a second queue over the same store sees the item.
        val reopened = UploadQueue(store) { now }
        assertEquals(1, reopened.pendingCount())
        assertEquals(1, reopened.dueItems().size)
        assertEquals("8AC3K2L9P1", reopened.dueItems().first().trxId)
    }

    @Test
    fun `enqueue dedupes by TrxID — a re-parsed payment never joins twice`() {
        assertTrue(queue.enqueue(item()))
        assertFalse(queue.enqueue(item()))
        assertEquals(1, queue.pendingCount())
    }

    @Test
    fun `a failed upload backs off 30s and the item is not due before the window`() {
        queue.enqueue(item())
        val id = queue.dueItems().first().id

        queue.markFailed(id)
        assertEquals(1, queue.pendingCount())
        assertEquals(0, queue.dueItems().size)

        // Not due at 29.999s, due once the 30s window elapses.
        now += 29_999
        assertEquals(0, queue.dueItems().size)
        now += 1
        assertEquals(1, queue.dueItems().size)
        assertEquals(1, queue.dueItems().first().attempts)
    }

    @Test
    fun `backoff doubles per attempt and caps at 30 minutes`() {
        assertEquals(30_000L, UploadQueue.backoffMs(1))
        assertEquals(60_000L, UploadQueue.backoffMs(2))
        assertEquals(120_000L, UploadQueue.backoffMs(3))
        assertEquals(UploadQueue.MAX_BACKOFF_MS, UploadQueue.backoffMs(7))
        assertEquals(UploadQueue.MAX_BACKOFF_MS, UploadQueue.backoffMs(50))
    }

    @Test
    fun `markFailed schedules the next attempt from the injected clock`() {
        queue.enqueue(item())
        val id = queue.dueItems().first().id

        now += 60_000L
        queue.markFailed(id)

        // First failure ⇒ attempts=1, next attempt at now + backoff(1) = now + 30s.
        // Read via the codec: the item is backing off, so dueItems() is empty.
        val stored = QueueCodec.decode(store.read()).first()
        assertEquals(1, stored.attempts)
        assertEquals(now + 30_000L, stored.nextAttemptAtMs)
    }

    @Test
    fun `remove takes the item out for good (uploaded or rejected upstream)`() {
        queue.enqueue(item())
        val id = queue.dueItems().first().id

        queue.remove(id)
        assertEquals(0, queue.pendingCount())
        assertEquals(0, UploadQueue(store) { now }.pendingCount())
    }

    @Test
    fun `PendingUpload factory converts paisa to the server's amountBdt contract`() {
        val fiveHundred = PendingUpload.from(
            sender = "bKash",
            parsed = ParsedPaymentSms("8AC3K2L9P1", 50000, "bkash"),
            rawBody = "",
            nowMs = now,
        )
        assertEquals(500.0, fiveHundred.amountBdt, 0.0)
        assertEquals(now, fiveHundred.nextAttemptAtMs)
        assertNotNull(fiveHundred.id)
        assertTrue(fiveHundred.id.isNotEmpty())

        val twelveZar = PendingUpload.from(
            sender = "bKash",
            parsed = ParsedPaymentSms("3F7E9A1B2C", 120050, "bkash"),
            rawBody = "",
            nowMs = now,
        )
        assertEquals(1200.5, twelveZar.amountBdt, 0.0)
    }

    @Test
    fun `codec round-trips hostile raw bodies (quotes, tabs, newlines, backslashes)`() {
        val hostile = "He said \"Tk 500.00\"\\\tline2\nTrxID 8AC3K2L9P1"
        val original = item(rawBody = hostile)

        val decoded = QueueCodec.decode(QueueCodec.encode(listOf(original)))

        assertEquals(1, decoded.size)
        assertEquals(original, decoded.first())
    }

    @Test
    fun `codec drops a corrupt line instead of wedging the whole queue`() {
        queue.enqueue(item(trxId = "GOOD000001"))
        queue.enqueue(item(trxId = "GOOD000002"))
        store.appendRaw("\ngarbage-not-an-item\n")

        val items = QueueCodec.decode(store.read())
        assertEquals(2, items.size)
    }
}
