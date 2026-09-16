/**
 * Wake guard (PLAN R5): scheduled work must be at-least-once on process wake.
 * Render spins down after 15 idle minutes; when the process wakes on a request,
 * any cron ticks missed during sleep are compensated by running the catch-up
 * sweep on the first request after each wake, plus once at boot.
 */
import type { FastifyInstance } from "fastify";

/**
 * Registers an onRequest hook that runs the catch-up sweep on the first request
 * after boot and after each idle gap ≥ the configured wake threshold. Never
 * awaits in the hot path: failures are logged, not propagated — a sweep must
 * not break user traffic.
 */
export function registerWakeGuard(app: FastifyInstance, wakeIdleThresholdSec: number): void {
  let lastActivitySec = Date.now() / 1000;
  let running = false;

  app.addHook("onRequest", async (_request, _reply) => {
    const nowSec = Date.now() / 1000;
    const idleSec = nowSec - lastActivitySec;
    lastActivitySec = nowSec;
    if (running || idleSec < wakeIdleThresholdSec) return;

    // Avoid re-entrancy while the sweep is in flight.
    running = true;
    try {
      await app.runCatchUpSweep();
      app.log.info({ job: "catch_up_sweep", trigger: "wake-guard" }, "catch-up sweep completed");
    } catch (err) {
      app.log.error({ err }, "wake-guard catch-up sweep failed");
    } finally {
      running = false;
    }
  });
}
