/**
 * Job runner (PLAN R3 + R5): node-cron inside the single Fastify process.
 * Jobs:
 *  - heartbeat_watchdog: flags devices whose last_seen_at is older than the
 *    configured staleness threshold, dispatches a webhook alert, logs.
 *  - catch_up_sweep: heartbeat watchdog catch-up with idempotent, at-least-once
 *    semantics on boot and first-request-after-wake (Render spin-down guard).
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { runBulkQueueTick } from "./services/bulk.js";

export interface StaleDevice {
  id: string;
  user_id: string;
  label: string;
  last_seen_at: number | null;
}

export interface WatchdogAlert {
  type: "device_heartbeat_stale";
  deviceIds: string[];
  count: number;
  threshold_sec: number;
  detected_at: string;
}

/**
 * Fired when an app's webhook receiver exhausts all dispatch retries
 * WEBHOOK_EXHAUSTION_ALERT_THRESHOLD times in a row — the receiver is very
 * likely down (dead receiver). Reset by any successful delivery.
 */
export interface WebhookExhaustionAlert {
  type: "webhook_exhaustion";
  appId: string;
  consecutiveFailures: number;
  threshold: number;
  lastSessionId: string;
  lastError: string;
  detected_at: string;
}

/** Every alert shape routed through the shared alert webhook channel. */
export type OpsAlert = WatchdogAlert | WebhookExhaustionAlert;

/** Registers the watchdog on the app for tests to call directly. */
declare module "fastify" {
  interface FastifyInstance {
    /** Runs one watchdog pass and returns the devices it found stale. */
    runWatchdog(): Promise<StaleDevice[]>;
    /** Runs one catch-up sweep pass. */
    runCatchUpSweep(): Promise<void>;
    /** Runs one bulk queue pass (reconcile → finalize → enqueue). */
    runBulkQueueTick(): Promise<{ reconciled: number; enqueued: number; finalized: number }>;
    /** Refreshes the stats snapshot row. */
    runStatsTick(): void;
    /** Starts cron scheduling (skipped in tests). */
    startJobs(): void;
    /** Stops cron scheduling. */
    stopJobs(): void;
  }
}

/** Finds devices whose last heartbeat is older than `staleSec` (or never seen but expected). */
export function findStaleDevices(db: FastifyInstance["db"], staleSec: number): StaleDevice[] {
  const cutoff = Math.floor(Date.now() / 1000) - staleSec;
  return db
    .prepare(
      "SELECT id, user_id, label, last_seen_at FROM devices " +
        "WHERE revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ?) " +
        "ORDER BY last_seen_at IS NOT NULL, last_seen_at ASC",
    )
    .all(cutoff) as StaleDevice[];
}

/**
 * Dispatches an ops alert (watchdog stale-devices or webhook exhaustion) to the
 * shared ALERT_WEBHOOK_URL channel. Webhook is best-effort: alerting must never
 * take the job runner (or the API) down. When no webhook is configured,
 * alerting is log-only (G6 gate: email/webhook parity is M6; webhook is the P0
 * channel).
 */
export async function dispatchAlert(
  log: FastifyBaseLogger,
  config: Config,
  alert: OpsAlert,
): Promise<"webhook" | "log-only"> {
  // Per-type log line: the log stream must name the alert kind explicitly so a
  // log-only deployment still distinguishes the two alert sources.
  switch (alert.type) {
    case "device_heartbeat_stale":
      log.warn({ alert }, "watchdog_alert");
      break;
    case "webhook_exhaustion":
      log.warn({ alert }, "webhook_exhaustion_alert");
      break;
  }
  if (config.alertWebhookUrl === "") {
    return "log-only";
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.alertWebhookSecret !== "") {
      headers.Authorization = `Bearer ${config.alertWebhookSecret}`;
    }
    const res = await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.error({ status: res.status }, "watchdog webhook alert failed");
      return "log-only";
    }
    return "webhook";
  } catch (err) {
    log.error({ err }, "watchdog webhook alert failed");
    return "log-only";
  }
}

/**
 * One watchdog pass: find stale devices, dispatch alert when any, log when none.
 * Exported for direct use by the catch-up sweep and tests.
 */
export async function watchdogTick(
  app: FastifyInstance,
): Promise<StaleDevice[]> {
  const config = app.config;
  const stale = findStaleDevices(app.db, config.watchdogStaleSec);
  if (stale.length === 0) {
    app.log.info({ job: "heartbeat_watchdog" }, "no stale devices");
    return [];
  }
  const alert: WatchdogAlert = {
    type: "device_heartbeat_stale",
    deviceIds: stale.map((d) => d.id),
    count: stale.length,
    threshold_sec: config.watchdogStaleSec,
    detected_at: new Date().toISOString(),
  };
  await dispatchAlert(app.log, config, alert);
  return stale;
}

/** One catch-up sweep pass (R5): watchdog + bulk queue drain + stats refresh. */
export async function catchUpSweepTick(app: FastifyInstance): Promise<void> {
  await watchdogTick(app);
  // The bulk queue drains on wake too — a paused Render instance must not
  // leave recipients stranded mid-campaign (at-least-once on first request).
  await runBulkQueueTick(app);
  runStatsTick(app);
}

/**
 * Aggregate stats snapshot (v4 aggregateStats parity): current OTP/bulk
 * counters into a single upserted row. Cheap enough for a slow cron; history
 * rollups stay a dashboard concern (not ported).
 */
export function runStatsTick(app: FastifyInstance): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const dayStart = nowSec - (nowSec % 86_400);
  const payload = {
    otp: {
      sessionsToday: (
        app.db.prepare("SELECT COUNT(*) AS n FROM otp_sessions WHERE created_at >= ?").get(dayStart) as { n: number }
      ).n,
      verified: (
        app.db.prepare("SELECT COUNT(*) AS n FROM otp_sessions WHERE status = 'verified'").get() as { n: number }
      ).n,
      locked: (
        app.db.prepare("SELECT COUNT(*) AS n FROM otp_sessions WHERE status = 'locked'").get() as { n: number }
      ).n,
      pending: (
        app.db.prepare("SELECT COUNT(*) AS n FROM otp_sessions WHERE status = 'pending'").get() as { n: number }
      ).n,
    },
    queue: {
      pendingSms: (
        app.db.prepare("SELECT COUNT(*) AS n FROM pending_sms WHERE status = 'pending'").get() as { n: number }
      ).n,
      claimedSms: (
        app.db.prepare("SELECT COUNT(*) AS n FROM pending_sms WHERE status = 'claimed'").get() as { n: number }
      ).n,
    },
    bulk: {
      campaignsToday: (
        app.db.prepare("SELECT COUNT(*) AS n FROM bulk_campaigns WHERE created_at >= ?").get(dayStart) as { n: number }
      ).n,
      active: (
        app.db.prepare("SELECT COUNT(*) AS n FROM bulk_campaigns WHERE status IN ('queued', 'sending')").get() as {
          n: number;
        }
      ).n,
      recipientsSent: (
        app.db.prepare("SELECT COALESCE(SUM(sent_count), 0) AS n FROM bulk_campaigns").get() as { n: number }
      ).n,
      recipientsFailed: (
        app.db.prepare("SELECT COALESCE(SUM(failed_count), 0) AS n FROM bulk_campaigns").get() as { n: number }
      ).n,
    },
    captured_at: nowSec,
  };
  app.db
    .prepare(
      "INSERT INTO stats_current (id, payload, updated_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
    )
    .run(JSON.stringify(payload), nowSec);
  app.log.debug({ stats: payload }, "stats snapshot");
}

/**
 * Registers the job runner: starts cron schedules and seeds the wake-guard hook.
 * Cron is started only when the caller passes startCron=true (tests pass false).
 */
export function registerJobs(
  app: FastifyInstance,
  config: Config,
  startCron: boolean,
): void {
  app.decorate("runWatchdog", () => watchdogTick(app));
  app.decorate("runCatchUpSweep", () => catchUpSweepTick(app));
  app.decorate("runBulkQueueTick", () => runBulkQueueTick(app));
  app.decorate("runStatsTick", () => runStatsTick(app));

  if (startCron) {
    // Lazy import keeps vitest free of node-cron timers when startCron=false.
    void (async () => {
      const cron = await import("node-cron");
      cron.schedule(config.watchdogCron, () => {
        watchdogTick(app).catch((err) => app.log.error({ err }, "watchdog job failed"));
      });
      cron.schedule(config.catchUpCron, () => {
        catchUpSweepTick(app).catch((err) => app.log.error({ err }, "catch-up job failed"));
      });
      cron.schedule(config.bulkQueueCron, () => {
        runBulkQueueTick(app).catch((err) => app.log.error({ err }, "bulk queue job failed"));
      });
      cron.schedule(config.statsCron, () => {
        try {
          runStatsTick(app);
        } catch (err) {
          app.log.error({ err }, "stats job failed");
        }
      });
      app.log.info(
        {
          watchdogCron: config.watchdogCron,
          catchUpCron: config.catchUpCron,
          bulkQueueCron: config.bulkQueueCron,
          statsCron: config.statsCron,
        },
        "job runner started",
      );
    })();
  }
}
