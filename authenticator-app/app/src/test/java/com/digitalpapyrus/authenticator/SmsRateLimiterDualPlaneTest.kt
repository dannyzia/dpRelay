package com.digitalpapyrus.authenticator

import android.app.PendingIntent
import com.digitalpapyrus.authenticator.ratelimit.SmsRateLimiter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mockito.Mockito

/**
 * JVM unit tests locking the dual-plane SmsRateLimiter contract (M4 W2).
 *
 * What the JVM can prove without an emulator: the legacy plane's call shape
 * (PendingSmsListener.sendSms) and the v5 plane's call shape
 * (OutstandingFetcher.enqueueSend) both land on the ONE process-wide queue,
 * each queued message is charged exactly one 5 s inter-send interval by the
 * limiter's wait model (the formula the dispatcher uses to space sends), and
 * dispatch is deferred to the scheduled drain — never run inline at enqueue
 * time. Handler-driven execution timing needs a real Looper; that layer is
 * unchanged here and its cross-plane spacing follows from the shared queue +
 * interval model asserted below (full evidence chain in
 * docs/httpsms vs dprelay/Modification 6/w2-toggle-additivity.md §4).
 *
 * These tests FAIL if a future change (a) splits the limiter into per-plane
 * instances (queue depth would fragment per shape), (b) shrinks the 5 s
 * inter-send policy (per-message wait deltas would drop), or (c) makes
 * enqueue dispatch inline (pacing would be bypassed).
 *
 * The limiter is a JVM-wide singleton, so every assertion is RELATIVE to the
 * depth/wait measured at test start — tests stay green in any order and
 * alongside other tests in the same JVM.
 */
class SmsRateLimiterDualPlaneTest {

  /** Opaque, never-touched stand-in for the non-null PendingIntent signature. */
  private val noopIntent: PendingIntent = Mockito.mock(PendingIntent::class.java)

  @Test
  fun `legacy and v5 call shapes accumulate on one shared queue`() {
    val depthBefore = SmsRateLimiter.getQueueDepth()

    // PendingSmsListener.sendSms shape (legacy Firebase plane).
    SmsRateLimiter.enqueueSms("+8801700000001", "legacy-plane", noopIntent, noopIntent) {}
    // OutstandingFetcher.enqueueSend shape (v5 device plane).
    SmsRateLimiter.enqueueSms("+8801700000002", "v5-plane", noopIntent, noopIntent) {}

    assertEquals(depthBefore + 2, SmsRateLimiter.getQueueDepth())
  }

  @Test
  fun `each cross-plane message costs exactly one 5 second interval`() {
    val depthBefore = SmsRateLimiter.getQueueDepth()

    // Prime the shared queue: from an EMPTY queue the first message would take
    // the immediately-free send slot (delta 0 by design — the phone is allowed
    // one send right away). With the queue primed, every further message moves
    // the next free slot out by exactly one MIN_INTERVAL_MS, so the deltas
    // below are exact regardless of prior test state in this JVM.
    SmsRateLimiter.enqueueSms("+8801700000009", "prime", noopIntent, noopIntent) {}
    val waitPrimed = SmsRateLimiter.getEstimatedWaitMs()
    assertTrue(waitPrimed >= 0)

    // One message from each plane: each adds exactly one MIN_INTERVAL_MS
    // (5000 ms) to the estimated wait — the cooldown the dual-plane run must
    // preserve.
    SmsRateLimiter.enqueueSms("+8801700000010", "legacy-plane", noopIntent, noopIntent) {}
    assertEquals(waitPrimed + 5_000L, SmsRateLimiter.getEstimatedWaitMs())

    SmsRateLimiter.enqueueSms("+8801700000011", "v5-plane", noopIntent, noopIntent) {}
    assertEquals(waitPrimed + 10_000L, SmsRateLimiter.getEstimatedWaitMs())

    assertEquals(depthBefore + 3, SmsRateLimiter.getQueueDepth())
  }

  @Test
  fun `enqueue never dispatches inline — sends stay behind the shared interval`() {
    var executedInline = false
    SmsRateLimiter.enqueueSms("+8801700000020", "deferred", noopIntent, noopIntent) {
      executedInline = true
    }
    // Dispatch belongs to the single handler-thread drain (>= 5 s spacing);
    // if enqueue ever ran the send action synchronously, the cooldown would
    // be bypassable by whichever plane enqueued last.
    assertFalse(executedInline)
  }

  @Test
  fun `wait model stays a non-negative bound on the next send slot`() {
    val wait = SmsRateLimiter.getEstimatedWaitMs()
    assertTrue("estimated wait must never be negative, got $wait", wait >= 0)
    // The model is interval-quantized: (max(depth-1, 0)) * 5000 on the JVM,
    // where no send has yet stamped lastSendTimestamp.
    assertEquals(0L, wait % 5_000L)
  }
}
