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

/** Every alert shape routed through the shared alert channels. */
export type OpsAlert = WatchdogAlert | WebhookExhaustionAlert;

/** HTML-escapes alert fields so parse_mode:"HTML" never breaks on their content. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders an alert as a compact Telegram HTML message: kind line first (the
 * on-call scan target), then the discriminating fields, timestamps last.
 */
function formatAlertHtml(alert: OpsAlert): string {
  switch (alert.type) {
    case "device_heartbeat_stale":
      return (
        "🔔 <b>device_heartbeat_stale</b>\n" +
        `count: ${alert.count} (threshold ${alert.threshold_sec}s)\n` +
        `devices: ${alert.deviceIds.map((id) => escapeHtml(id)).join(", ")}\n` +
        `detected_at: ${escapeHtml(alert.detected_at)}`
      );
    case "webhook_exhaustion":
      return (
        "🔔 <b>webhook_exhaustion</b>\n" +
        `app: ${escapeHtml(alert.appId)}\n` +
        `consecutiveFailures: ${alert.consecutiveFailures} (threshold ${alert.threshold})\n` +
        `lastSessionId: ${escapeHtml(alert.lastSessionId)}\n` +
        `lastError: ${escapeHtml(alert.lastError)}\n` +
        `detected_at: ${escapeHtml(alert.detected_at)}`
      );
  }
}

/** Which configured alert sink a health record refers to. */
type AlertSinkKind = "telegram" | "webhook";

interface AlertSinkHealth {
  /** Consecutive failed dispatches; reset to 0 by the first success. */
  consecutiveFailures: number;
  /** ISO time of the failure that first crossed the threshold; null while healthy. */
  degradedSince: string | null;
  /** Most recent failure detail, carried into the escalation line. */
  lastError: string;
}

/**
 * Per-sink failure counters, keyed by sink kind.
 *
 * dispatchAlert swallows failures by contract — an alerting path must never take
 * the job runner down — but that contract has a blind spot: a permanently broken
 * ALERT_WEBHOOK_URL is indistinguishable from "no sink configured". Both return
 * "log-only" on every tick, and both emit only a per-failure error line that
 * reads like routine noise once the watchdog has been firing for a while. Nothing
 * in the log stream marks the transition into "we have been shouting into a dead
 * receiver for an hour", which is exactly the failure an operator needs to notice.
 *
 * Deliberately in-process and unpersisted. The watchdog is a single-process cron
 * (constraint R3), so a restart legitimately returns to a clean slate, and a new
 * table would buy a migration for state that carries no meaning across restarts.
 */
const alertSinkHealth = new Map<AlertSinkKind, AlertSinkHealth>();

/**
 * Records one dispatch outcome against its sink and emits the degraded/recovered
 * transitions. Mirrors its callers' contract: never throws, never rejects.
 *
 * `alert_sink_degraded` fires once when the consecutive-failure count reaches the
 * threshold, then again on each further multiple of the threshold, so the signal
 * survives log rotation without degenerating into a per-tick wall of duplicates.
 */
function recordSinkOutcome(
  log: FastifyBaseLogger,
  config: Config,
  kind: AlertSinkKind,
  delivered: boolean,
  detail: string,
): void {
  const threshold = config.alertSinkFailureThreshold;
  const health = alertSinkHealth.get(kind) ?? {
    consecutiveFailures: 0,
    degradedSince: null,
    lastError: "",
  };

  if (delivered) {
    if (health.degradedSince !== null) {
      log.info(
        {
          sink: kind,
          consecutiveFailures: health.consecutiveFailures,
          degradedSince: health.degradedSince,
        },
        "alert_sink_recovered",
      );
    }
    health.consecutiveFailures = 0;
    health.degradedSince = null;
    health.lastError = "";
    alertSinkHealth.set(kind, health);
    return;
  }

  health.consecutiveFailures += 1;
  health.lastError = detail;
  const crossed = health.consecutiveFailures === threshold;
  const repeats = health.consecutiveFailures > threshold && health.consecutiveFailures % threshold === 0;
  if (crossed) {
    health.degradedSince = new Date().toISOString();
  }
  if (crossed || repeats) {
    log.error(
      {
        sink: kind,
        consecutiveFailures: health.consecutiveFailures,
        threshold,
        degradedSince: health.degradedSince,
        lastError: health.lastError,
      },
      "alert_sink_degraded",
    );
  }
  alertSinkHealth.set(kind, health);
}

/**
 * Clears the sink health counters. Exported for tests only — in production the
 * counters are process-lifetime by design.
 */
export function resetAlertSinkHealth(): void {
  alertSinkHealth.clear();
}

/**
 * Telegram Bot API sendMessage. Same best-effort contract as the webhook
 * channel: bounded timeout, failures logged and swallowed.
 */
async function dispatchTelegram(
  log: FastifyBaseLogger,
  config: Config,
  text: string,
): Promise<"telegram" | "log-only"> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      recordSinkOutcome(log, config, "telegram", false, `HTTP ${res.status}`);
      log.error({ status: res.status }, "telegram alert failed");
      return "log-only";
    }
    recordSinkOutcome(log, config, "telegram", true, "");
    return "telegram";
  } catch (err) {
    recordSinkOutcome(log, config, "telegram", false, err instanceof Error ? err.message : String(err));
    log.error({ err }, "telegram alert failed");
    return "log-only";
  }
}

/**
 * Generic ALERT_WEBHOOK_URL receiver (Discord/Slack-compatible). Kept as the
 * fallback sink; failure is logged and swallowed.
 */
async function dispatchWebhook(
  log: FastifyBaseLogger,
  config: Config,
  alert: OpsAlert,
): Promise<"webhook" | "log-only"> {
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
      recordSinkOutcome(log, config, "webhook", false, `HTTP ${res.status}`);
      log.error({ status: res.status }, "watchdog webhook alert failed");
      return "log-only";
    }
    recordSinkOutcome(log, config, "webhook", true, "");
    return "webhook";
  } catch (err) {
    recordSinkOutcome(log, config, "webhook", false, err instanceof Error ? err.message : String(err));
    log.error({ err }, "watchdog webhook alert failed");
    return "log-only";
  }
}

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

/**
 * Finds devices whose last heartbeat is older than `staleSec`.
 *
 * A device that has NEVER been seen (last_seen_at IS NULL) is measured against
 * `created_at` instead, not against the clock at large. The previous query tested
 * `last_seen_at IS NULL` with no age bound at all, which made every freshly
 * enrolled phone stale the instant its row was created and kept it stale forever
 * if it never heartbeated — both provisioning routes insert NULL deliberately, so
 * this was the normal state of any unenrolled device rather than an anomaly. The
 * net effect was a permanent alert every tick for a phone nobody had finished
 * setting up, which is exactly the noise that stopped anyone reading the watchdog
 * (ISSUE-38).
 */
export function findStaleDevices(db: FastifyInstance["db"], staleSec: number): StaleDevice[] {
  const cutoff = Math.floor(Date.now() / 1000) - staleSec;
  return db
    .prepare(
      "SELECT id, user_id, label, last_seen_at FROM devices " +
        "WHERE revoked_at IS NULL AND ((last_seen_at IS NULL AND created_at < ?) OR " +
        "(last_seen_at IS NOT NULL AND last_seen_at < ?)) " +
        "ORDER BY last_seen_at IS NOT NULL, last_seen_at ASC",
    )
    .all(cutoff, cutoff) as StaleDevice[];
}

/**
 * Result of one alert dispatch: which sink accepted it, or "log-only" when no
 * sink was configured or every configured sink failed.
 */
export type AlertDispatchResult = "telegram" | "webhook" | "log-only";

/**
 * Dispatches an ops alert (watchdog stale-devices or webhook exhaustion) to
 * the operator alert channel. TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID configure
 * the preferred Telegram sink (HTML message); ALERT_WEBHOOK_URL remains the
 * generic receiver and is tried when Telegram is unconfigured or its delivery
 * failed. Alerting is best-effort and must never take the job runner (or the
 * API) down; with no sink configured, alerting is log-only (G6 gate: email
 * parity is M6).
 */
export async function dispatchAlert(
  log: FastifyBaseLogger,
  config: Config,
  alert: OpsAlert,
): Promise<AlertDispatchResult> {
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
  if (config.telegramBotToken !== "" && config.telegramChatId !== "") {
    const result = await dispatchTelegram(log, config, formatAlertHtml(alert));
    if (result === "telegram") return result;
  }
  if (config.alertWebhookUrl !== "") {
    return dispatchWebhook(log, config, alert);
  }
  return "log-only";
}

/**
 * Tracks the last alerted stale-device set so an UNCHANGED set is not
 * re-announced on every tick. Process-local for the same reason as the sink
 * health counters: the watchdog is a single-process cron (R3) and a restart
 * legitimately returns to a clean slate. The consequence is a single repeat
 * alert after a restart, which is the safe direction to err in.
 */
let lastStaleSignature: string | null = null;
let lastStaleAlertAtMs: number | null = null;

/** Clears the stale-alert dedupe state. Test-only; see lastStaleSignature. */
export function resetStaleAlertDedupe(): void {
  lastStaleSignature = null;
  lastStaleAlertAtMs = null;
}

/**
 * One watchdog pass: find stale devices, dispatch alert when any, log when none.
 *
 * Dedupe: the alert fires when the stale set CHANGES (a device goes stale or
 * recovers), or when an unchanged set has gone unannounced for
 * `watchdogAlertRepeatSec`. Suppressed ticks log at info rather than silently,
 * so the log still shows the watchdog is alive and seeing the same thing.
 */
export async function watchdogTick(
  app: FastifyInstance,
): Promise<StaleDevice[]> {
  const config = app.config;
  const stale = findStaleDevices(app.db, config.watchdogStaleSec);
  if (stale.length === 0) {
    app.log.info({ job: "heartbeat_watchdog" }, "no stale devices");
    // A recovered set must not pin the next alert as "unchanged", so clear here
    // rather than comparing against an empty set forever.
    lastStaleSignature = null;
    lastStaleAlertAtMs = null;
    return [];
  }
  const signature = stale
    .map((d) => d.id)
    .sort()
    .join(",");
  const nowMs = Date.now();
  const unchanged = signature === lastStaleSignature;
  const repeatDue =
    lastStaleAlertAtMs !== null &&
    nowMs - lastStaleAlertAtMs >= config.watchdogAlertRepeatSec * 1000;

  if (unchanged && !repeatDue) {
    app.log.info(
      {
        job: "heartbeat_watchdog",
        deviceIds: stale.map((d) => d.id),
        count: stale.length,
        suppressedForSec:
          lastStaleAlertAtMs === null ? null : Math.floor((nowMs - lastStaleAlertAtMs) / 1000),
        repeatInSec: config.watchdogAlertRepeatSec,
      },
      "watchdog_alert_suppressed_unchanged_set",
    );
    return stale;
  }

  const alert: WatchdogAlert = {
    type: "device_heartbeat_stale",
    deviceIds: stale.map((d) => d.id),
    count: stale.length,
    threshold_sec: config.watchdogStaleSec,
    detected_at: new Date().toISOString(),
  };
  await dispatchAlert(app.log, config, alert);
  lastStaleSignature = signature;
  lastStaleAlertAtMs = nowMs;
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
