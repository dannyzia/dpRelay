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
import {
  ALERT_CANARY_STATE_KEY,
  ALERT_SINK_STATE_KEY,
  WATCHDOG_DEDUPE_STATE_KEY,
  loadJobState,
  saveJobState,
} from "./job-state.js";
import type {
  PersistedAlertCanary,
  PersistedSinkHealth,
  PersistedWatchdogDedupe,
} from "./job-state.js";
import { runBulkQueueTick } from "./services/bulk.js";

export interface StaleDevice {
  id: string;
  user_id: string;
  label: string;
  last_seen_at: number | null;
  /** STAGE F7 (ISSUE-87): gateway number when known, else null. */
  phone_number: string | null;
}

export interface WatchdogAlert {
  type: "device_heartbeat_stale";
  deviceIds: string[];
  /** STAGE F7: the stale devices' phone numbers, positionally aligned with deviceIds (null = unknown). */
  phones: (string | null)[];
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

/**
 * Fired when the best-effort FCM gateway wake keeps failing, because that is
 * otherwise invisible: OTP delivery still succeeds via the phone's reconcile
 * fetch, so a revoked or under-permissioned push credential shows up as nothing
 * at all. See fcm-wake-alert.ts for the classification and dedupe rules.
 */
export interface FcmWakeFailureAlert {
  type: "fcm_wake_failed";
  /** credential failures page at once; transient/token wait for the threshold. */
  failureClass: "credential" | "token" | "transient";
  consecutiveFailures: number;
  threshold: number;
  /** Secret-free: the firebase-admin error code plus a clipped message. */
  lastError: string;
  detected_at: string;
}

/**
 * Fired when the daily canary could not obtain a delivery receipt from the
 * Telegram sink.
 *
 * This is the one alert that must never be delivered through the channel it is
 * complaining about, so `dispatchAlert` deliberately does not route it to
 * Telegram — see dispatchAlert's canary branch. `lastReceiptAt` is the evidence
 * an operator needs to size the outage: "never delivered" and "delivered 26h
 * ago then stopped" are very different incidents.
 */
export interface AlertCanaryFailureAlert {
  type: "alert_canary_failed";
  consecutiveFailures: number;
  /** Secret-free: an HTTP status or a transport error class. */
  lastError: string;
  /** ISO time a receipt last landed; null means never, since this row existed. */
  lastReceiptAt: string | null;
  detected_at: string;
}

/** Every alert shape routed through the shared alert channels. */
export type OpsAlert =
  | WatchdogAlert
  | WebhookExhaustionAlert
  | FcmWakeFailureAlert
  | AlertCanaryFailureAlert;

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
        // STAGE F7: the number makes a stale phone identifiable without
        // opening the panel — the whole point of the identity primitive.
        `phones: ${alert.phones.map((p) => escapeHtml(p ?? "unknown")).join(", ")}\n` +
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
    case "fcm_wake_failed":
      return (
        "🚨 <b>fcm_wake_failed</b>\n" +
        `class: ${escapeHtml(alert.failureClass)}\n` +
        `consecutiveFailures: ${alert.consecutiveFailures} (threshold ${alert.threshold})\n` +
        `lastError: ${escapeHtml(alert.lastError)}\n` +
        `detected_at: ${escapeHtml(alert.detected_at)}`
      );
    case "alert_canary_failed":
      // Reached only when a webhook fallback is configured — the canary's own
      // failure is never sent to Telegram. Rendered anyway so the type switch
      // stays total and a future webhook-only deployment gets a real message
      // instead of the literal string "undefined".
      return (
        "🚨 <b>alert_canary_failed</b>\n" +
        `consecutiveFailures: ${alert.consecutiveFailures}\n` +
        `lastReceiptAt: ${alert.lastReceiptAt === null ? "never" : escapeHtml(alert.lastReceiptAt)}\n` +
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
 * Persisted in `job_state` (migration 011) on every state transition. This was
 * deliberately in-process for a while: the watchdog is a single-process cron
 * (constraint R3), so a restart used to return to a clean slate, and the
 * resulting "one repeat alert after a restart" was argued to be the safe
 * direction to err in. That argument covers the DEDUPE, but not this counter —
 * resetting a sink to healthy on every deploy meant a receiver dead for an hour
 * reported itself fine the instant a new build booted, and /health/alerts
 * returned 200 over a live outage. A monitoring signal that goes green when
 * nobody fixed it is worse than one that starts red.
 *
 * The in-memory Map stays the hot path; the table is written only when a sink
 * flips between healthy and degraded, never on every attempt.
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
  db: FastifyInstance["db"] | null,
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
    const wasDegraded = health.degradedSince !== null;
    if (wasDegraded) {
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
    // Transition (degraded -> healthy), so this is the moment worth a write.
    if (wasDegraded && db) persistSinkHealth(db);
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
  // Only the crossing is a transition. A "repeats" escalation leaves the sink
  // degraded exactly as it was, so it costs no write; the count is allowed to
  // rewind to the threshold on a restart, which /health/alerts still reports
  // correctly because `degradedSince` is what decides degraded-vs-healthy.
  if (crossed && db) persistSinkHealth(db);
}

/**
 * Writes every sink's counters to `job_state` as a single row.
 *
 * One row rather than one per sink so a transition is one atomic write and a
 * half-applied snapshot is impossible. `lastError` is stripped here and that is
 * not an oversight: it carries the failing URL or response body, and this row is
 * read on every boot.
 */
function persistSinkHealth(db: FastifyInstance["db"]): void {
  const snapshot: Record<string, PersistedSinkHealth> = {};
  for (const [kind, health] of alertSinkHealth) {
    snapshot[kind] = {
      consecutiveFailures: health.consecutiveFailures,
      degradedSince: health.degradedSince,
    };
  }
  saveJobState(db, ALERT_SINK_STATE_KEY, snapshot);
}

/**
 * Restores sink counters from `job_state` into the in-process Map.
 *
 * Called once at job-runner registration. Rows that do not parse, or name a
 * sink that no longer exists, are ignored rather than trusted — a malformed row
 * must not be able to invent a degraded sink that nobody can clear.
 */
export function hydrateSinkHealth(db: FastifyInstance["db"]): void {
  const raw = loadJobState(db).get(ALERT_SINK_STATE_KEY);
  if (typeof raw !== "object" || raw === null) return;
  for (const kind of ALERT_SINK_KINDS) {
    const entry = (raw as Record<string, unknown>)[kind];
    if (typeof entry !== "object" || entry === null) continue;
    const { consecutiveFailures, degradedSince } = entry as Partial<PersistedSinkHealth>;
    alertSinkHealth.set(kind, {
      consecutiveFailures:
        typeof consecutiveFailures === "number" && consecutiveFailures >= 0
          ? consecutiveFailures
          : 0,
      degradedSince: typeof degradedSince === "string" ? degradedSince : null,
      // Never restored: see persistSinkHealth.
      lastError: "",
    });
  }
}

/**
 * Clears the sink health counters. Exported for tests only — in production they
 * are restored from `job_state` at boot and updated on every transition.
 */
export function resetAlertSinkHealth(): void {
  alertSinkHealth.clear();
}

/** Every alert sink, in the order the dispatcher prefers them. */
const ALERT_SINK_KINDS: readonly AlertSinkKind[] = ["telegram", "webhook"];

/** Whether a sink has enough configuration to be attempted at all. */
function isSinkConfigured(kind: AlertSinkKind, config: Config): boolean {
  return kind === "telegram"
    ? config.telegramBotToken !== "" && config.telegramChatId !== ""
    : config.alertWebhookUrl !== "";
}

/**
 * Redacted health of one sink.
 *
 * `lastError` is deliberately NOT exposed. It carries whatever the failing
 * transport put into it — a webhook URL, a response body — and this payload is
 * unauthenticated so that a monitor or uptime check can poll it without holding
 * the operator secret. Counters and a timestamp are enough to page on; the
 * detail belongs in the log stream, which is already access-controlled.
 */
export interface AlertSinkStatusEntry {
  sink: AlertSinkKind;
  configured: boolean;
  consecutiveFailures: number;
  /** ISO time the sink crossed the failure threshold; null while healthy. */
  degradedSince: string | null;
}

/** Aggregate alerting reachability, for an external monitor. */
export interface AlertSinkStatus {
  /** True when alerts cannot currently reach an operator. */
  degraded: boolean;
  /** Plain-language cause, suitable for surfacing in a monitor's alert body. */
  reason: string;
  sinks: AlertSinkStatusEntry[];
}

/**
 * Whether this process can currently reach an operator at all.
 *
 * Two distinct conditions both mean "nobody is being told", and they are treated
 * as one because they demand the same response:
 *
 *  1. No sink is configured. Every alert is log-only. This is NOT reported as
 *     healthy: an alerting path that does not exist is not an operational
 *     green, and returning 200 here would be the same silent-success failure
 *     this whole mechanism exists to catch.
 *  2. A configured sink is failing. `alert_sink_degraded` fired in the log, but
 *     a log line pages nobody.
 *
 * Deliberately a separate endpoint from `/health`, which must keep returning
 * 200. Pointing a platform health check at a 503 endpoint turns "Telegram is
 * down" into "restart the API", converting an alerting outage into a full
 * service outage.
 */
export function alertSinkStatus(config: Config): AlertSinkStatus {
  const sinks: AlertSinkStatusEntry[] = ALERT_SINK_KINDS.map((kind) => {
    const health = alertSinkHealth.get(kind);
    return {
      sink: kind,
      configured: isSinkConfigured(kind, config),
      consecutiveFailures: health?.consecutiveFailures ?? 0,
      degradedSince: health?.degradedSince ?? null,
    };
  });

  const configured = sinks.filter((s) => s.configured);
  if (configured.length === 0) {
    return {
      degraded: true,
      reason:
        "no alert sink is configured — set ALERT_WEBHOOK_URL and/or " +
        "TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID; every alert is currently log-only",
      sinks,
    };
  }
  const failing = configured.find((s) => s.degradedSince !== null);
  if (failing) {
    return {
      degraded: true,
      reason:
        `alert sink '${failing.sink}' has failed ${failing.consecutiveFailures} times ` +
        `consecutively since ${failing.degradedSince}; alerts are not reaching an operator`,
      sinks,
    };
  }
  return { degraded: false, reason: "ok — every configured alert sink is delivering", sinks };
}

/**
 * The alert canary: one synthetic message a day, and a page if no receipt lands.
 *
 * Why this exists on top of the one-shot `alert-channel-selftest.ts`: that script
 * proves the channel works at the moment someone runs it, and then proves nothing
 * for the next six months. A revoked token, a bot removed from the group, or a
 * rotated chat id all fail silently — the watchdog keeps dispatching, the sink
 * keeps reporting itself healthy until the failure threshold trips, and the
 * first person to find out is whoever is on call during a real incident. Nothing
 * in the system was asking the only question that matters: "did a message
 * actually arrive, recently?"
 *
 * The receipt is Telegram's own `message_id`. That is the strongest evidence the
 * Bot API can give without a human in the loop: it proves the token was accepted, 
 * the chat was reachable, and the message was created. It does NOT prove a human
 * read it — no bot API can, and this does not pretend otherwise. A human-read
 * guarantee would need an acknowledgement path that does not exist here.
 *
 * On failure it escalates through ALERT_WEBHOOK_URL and NOT through Telegram,
 * for the reason spelled out in dispatchAlert. With no webhook configured the
 * failure is log-only plus `/health/alerts`, which is the honest state: a
 * deployment whose only sink is the one being tested has no second channel, and
 * pretending otherwise would be the same silent-success bug this catches.
 */
interface AlertCanaryState {
  lastReceiptAtMs: number | null;
  lastMessageId: number | null;
  lastAttemptAtMs: number | null;
  lastFailureAtMs: number | null;
  consecutiveFailures: number;
}

const canaryState: AlertCanaryState = {
  lastReceiptAtMs: null,
  lastMessageId: null,
  lastAttemptAtMs: null,
  lastFailureAtMs: null,
  consecutiveFailures: 0,
};

/** Writes the canary's evidence so a redeploy does not erase it. */
function persistCanaryState(db: FastifyInstance["db"]): void {
  const snapshot: PersistedAlertCanary = {
    lastReceiptAtMs: canaryState.lastReceiptAtMs,
    lastMessageId: canaryState.lastMessageId,
    lastAttemptAtMs: canaryState.lastAttemptAtMs,
    lastFailureAtMs: canaryState.lastFailureAtMs,
    consecutiveFailures: canaryState.consecutiveFailures,
  };
  saveJobState(db, ALERT_CANARY_STATE_KEY, snapshot);
}

/**
 * Restores canary state at boot, so "when did this last work?" outlives a deploy.
 *
 * Tolerant like the other hydrators: a malformed row is ignored rather than
 * trusted, because inventing a receipt time would let a broken channel report
 * itself as recently verified.
 */
export function hydrateCanaryState(db: FastifyInstance["db"]): void {
  const raw = loadJobState(db).get(ALERT_CANARY_STATE_KEY);
  if (typeof raw !== "object" || raw === null) return;
  const entry = raw as Partial<PersistedAlertCanary>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  canaryState.lastReceiptAtMs = num(entry.lastReceiptAtMs);
  canaryState.lastMessageId = num(entry.lastMessageId);
  canaryState.lastAttemptAtMs = num(entry.lastAttemptAtMs);
  canaryState.lastFailureAtMs = num(entry.lastFailureAtMs);
  canaryState.consecutiveFailures =
    typeof entry.consecutiveFailures === "number" && entry.consecutiveFailures >= 0
      ? entry.consecutiveFailures
      : 0;
}

/** Clears canary state. Exported for tests only. */
export function resetAlertCanaryState(): void {
  canaryState.lastReceiptAtMs = null;
  canaryState.lastMessageId = null;
  canaryState.lastAttemptAtMs = null;
  canaryState.lastFailureAtMs = null;
  canaryState.consecutiveFailures = 0;
}

/** Redacted canary state for `/health/alerts`. */
export interface AlertCanaryStatus {
  /** False when the canary is switched off, so a monitor can tell off from broken. */
  enabled: boolean;
  lastReceiptAt: string | null;
  lastMessageId: number | null;
  lastAttemptAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /**
   * True when a receipt is overdue — never landed, or older than the freshness
   * window. Computed rather than stored so it cannot go stale between ticks.
   */
  overdue: boolean;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Whether the canary's last receipt is too old to trust.
 *
 * `maxAgeSec` is derived from the cron schedule with generous slack: a daily
 * canary that has not delivered in two days is not "a bit late", it is broken,
 * and the window must not be so tight that one missed run pages anyone.
 */
export function alertCanaryStatus(config: Config, nowMs: number = Date.now()): AlertCanaryStatus {
  const maxAgeMs = config.alertCanaryMaxAgeSec * 1000;
  // A canary that has never delivered a receipt is overdue, not merely untested:
  // "no receipt has ever landed" is the strongest form of the condition this
  // reports, and treating it as healthy-until-first-run would leave a fresh
  // deployment silently unverified for as long as nobody looked.
  const overdue =
    canaryState.lastReceiptAtMs === null || nowMs - canaryState.lastReceiptAtMs > maxAgeMs;
  return {
    enabled: config.alertCanaryEnabled,
    lastReceiptAt: iso(canaryState.lastReceiptAtMs),
    lastMessageId: canaryState.lastMessageId,
    lastAttemptAt: iso(canaryState.lastAttemptAtMs),
    lastFailureAt: iso(canaryState.lastFailureAtMs),
    consecutiveFailures: canaryState.consecutiveFailures,
    overdue,
  };
}

/**
 * Sends one canary message and returns whether a receipt landed.
 *
 * Parses the Bot API response rather than trusting the HTTP status: Telegram
 * answers 200 with `ok:false` for some failures, and a proxy or captive portal
 * can answer 200 with something that is not a Bot API response at all. A
 * `message_id` is the only thing that counts as a receipt.
 */
async function sendCanaryReceipt(
  log: FastifyBaseLogger,
  config: Config,
): Promise<{ ok: true; messageId: number } | { ok: false; detail: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text:
          "🟢 <b>dprelay alert canary</b>\n" +
          "Synthetic message — no action needed.\n" +
          "If this stops arriving, the alert channel is down and the server will " +
          "escalate through its fallback channel.",
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; result?: { message_id?: unknown } };
    if (body.ok !== true) return { ok: false, detail: "response ok:false" };
    const messageId = body.result?.message_id;
    if (typeof messageId !== "number") return { ok: false, detail: "no message_id in response" };
    return { ok: true, messageId };
  } catch (err) {
    // Transport failures are named by class only: the raw message can carry the
    // request URL, and the request URL contains the bot token.
    const detail = err instanceof Error ? err.name : "unknown error";
    log.error({ errName: detail }, "alert canary send failed");
    return { ok: false, detail };
  }
}

/**
 * One canary run: send, record the receipt, and escalate when none lands.
 *
 * Returns the receipt outcome so a test can assert on it without scraping logs.
 * Never throws: like every other path in this file, a monitoring job must not be
 * able to take the process down.
 */
export async function alertCanaryTick(
  app: FastifyInstance,
): Promise<{ delivered: boolean; messageId: number | null; detail: string | null }> {
  const config = app.config;
  if (!config.alertCanaryEnabled) {
    return { delivered: false, messageId: null, detail: "canary disabled" };
  }
  if (config.telegramBotToken === "" || config.telegramChatId === "") {
    // Not an escalation case: with no Telegram sink there is nothing to verify,
    // and reporting "the channel is broken" would be noise about a channel the
    // operator deliberately did not configure.
    app.log.warn({ job: "alert_canary" }, "alert canary skipped: telegram sink not configured");
    return { delivered: false, messageId: null, detail: "telegram not configured" };
  }

  canaryState.lastAttemptAtMs = Date.now();
  const result = await sendCanaryReceipt(app.log, config);

  // The canary's send goes through the same token and chat as a real alert, so
  // its outcome is evidence about the TELEGRAM SINK, not just about the canary.
  // Feeding it back keeps the two signals in /health/alerts from contradicting
  // each other — otherwise a dead token would show the canary overdue while
  // `sinks[telegram].degradedSince` still read null, which is the misleading
  // green this whole mechanism exists to remove.
  if (result.ok) {
    canaryState.lastReceiptAtMs = Date.now();
    canaryState.lastMessageId = result.messageId;
    canaryState.consecutiveFailures = 0;
    persistCanaryState(app.db);
    recordSinkOutcome(app.db, app.log, config, "telegram", true, "");
    app.log.info(
      { job: "alert_canary", messageId: result.messageId },
      "alert_canary_delivered",
    );
    return { delivered: true, messageId: result.messageId, detail: null };
  }

  canaryState.lastFailureAtMs = Date.now();
  canaryState.consecutiveFailures += 1;
  persistCanaryState(app.db);
  recordSinkOutcome(app.db, app.log, config, "telegram", false, result.detail);
  app.log.error(
    {
      job: "alert_canary",
      consecutiveFailures: canaryState.consecutiveFailures,
      lastReceiptAt: iso(canaryState.lastReceiptAtMs),
      detail: result.detail,
    },
    "alert_canary_no_receipt",
  );

  // Escalation is gated on the same consecutive-failure threshold the sinks use,
  // so one transient Telegram wobble does not page anyone. A canary that pages on
  // a single blip gets muted, and a muted canary is worse than none.
  const threshold = config.alertSinkFailureThreshold;
  const crossed = canaryState.consecutiveFailures === threshold;
  const repeats =
    canaryState.consecutiveFailures > threshold &&
    canaryState.consecutiveFailures % threshold === 0;
  if (crossed || repeats) {
    const alert: AlertCanaryFailureAlert = {
      type: "alert_canary_failed",
      consecutiveFailures: canaryState.consecutiveFailures,
      lastError: result.detail,
      lastReceiptAt: iso(canaryState.lastReceiptAtMs),
      detected_at: new Date().toISOString(),
    };
    await dispatchAlert(app.log, config, alert, app.db);
  }

  return { delivered: false, messageId: null, detail: result.detail };
}

/**
 * Telegram Bot API sendMessage. Same best-effort contract as the webhook
 * channel: bounded timeout, failures logged and swallowed.
 */
async function dispatchTelegram(
  log: FastifyBaseLogger,
  config: Config,
  text: string,
  db: FastifyInstance["db"] | null = null,
): Promise<"telegram" | "log-only"> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      recordSinkOutcome(db, log, config, "telegram", false, `HTTP ${res.status}`);
      log.error({ status: res.status }, "telegram alert failed");
      return "log-only";
    }
    recordSinkOutcome(db, log, config, "telegram", true, "");
    return "telegram";
  } catch (err) {
    recordSinkOutcome(db, log, config, "telegram", false, err instanceof Error ? err.message : String(err));
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
  db: FastifyInstance["db"] | null = null,
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
      recordSinkOutcome(db, log, config, "webhook", false, `HTTP ${res.status}`);
      log.error({ status: res.status }, "watchdog webhook alert failed");
      return "log-only";
    }
    recordSinkOutcome(db, log, config, "webhook", true, "");
    return "webhook";
  } catch (err) {
    recordSinkOutcome(db, log, config, "webhook", false, err instanceof Error ? err.message : String(err));
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
    /** Runs one alert-canary pass (sends a synthetic message, records the receipt). */
    runAlertCanary(): Promise<{ delivered: boolean; messageId: number | null; detail: string | null }>;
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
      "SELECT id, user_id, label, last_seen_at, phone_number FROM devices " +
        "WHERE revoked_at IS NULL AND quarantined_at IS NULL AND " +
        "((last_seen_at IS NULL AND created_at < ?) OR " +
        "(last_seen_at IS NOT NULL AND last_seen_at < ?)) " +
        "ORDER BY last_seen_at IS NOT NULL, last_seen_at ASC",
    )
    .all(cutoff, cutoff) as StaleDevice[];
}

/**
 * Silently quarantines devices that have never sent a heartbeat and are older
 * than `quarantineSec`.
 *
 * Scoped to never-seen devices ON PURPOSE. A device that once worked and then
 * went quiet is a genuine outage signal and must keep alerting — reaping on that
 * basis could cut over the only working gateway during an incident. A device that
 * has never once checked in is almost certainly an abandoned enrolment, and the
 * only thing it accomplishes is permanent alert noise.
 *
 * Quarantine is NOT revocation: the device keeps working and a single heartbeat
 * clears it (see the heartbeat handler). There is no device unrevoke route, so
 * revocation stays a deliberate operator decision.
 *
 * Returns the ids quarantined by THIS call, so the caller logs a real
 * transition rather than a count including rows it did not touch.
 */
export function quarantineNeverSeenDevices(
  db: FastifyInstance["db"],
  quarantineSec: number,
): string[] {
  const cutoff = Math.floor(Date.now() / 1000) - quarantineSec;
  const candidates = db
    .prepare(
      "SELECT id FROM devices " +
        "WHERE revoked_at IS NULL AND quarantined_at IS NULL AND " +
        "last_seen_at IS NULL AND created_at < ?",
    )
    .all(cutoff) as { id: string }[];
  if (candidates.length === 0) return [];
  const mark = db.prepare("UPDATE devices SET quarantined_at = ? WHERE id = ?");
  const now = Math.floor(Date.now() / 1000);
  for (const c of candidates) mark.run(now, c.id);
  return candidates.map((c) => c.id);
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
  // Optional so existing callers keep compiling — but a production caller that
  // omits it loses persistence on that path, so both production call sites pass
  // app.db and a test pins that they do.
  db: FastifyInstance["db"] | null = null,
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
    case "fcm_wake_failed":
      // warn, not error: the OTP request itself succeeded, so this is a
      // degraded channel rather than a failed request. The alert TYPE is what
      // makes it findable in a log-only deployment.
      log.warn({ alert }, "fcm_wake_failed_alert");
      break;
    case "alert_canary_failed":
      // error, not warn: unlike a stale device, this means the operator would
      // not be told about anything else either.
      log.error({ alert }, "alert_canary_failed_alert");
      break;
  }
  // The canary exists to detect that Telegram stopped delivering, so routing its
  // failure BACK through Telegram would make the alarm depend on the broken
  // thing — a dead token swallows its own page and the channel looks healthy
  // precisely because it is dead. Escalate through the webhook only, and let
  // /health/alerts carry the state for an external monitor.
  if (alert.type === "alert_canary_failed") {
    if (config.alertWebhookUrl !== "") {
      return dispatchWebhook(log, config, alert, db);
    }
    return "log-only";
  }
  if (config.telegramBotToken !== "" && config.telegramChatId !== "") {
    const result = await dispatchTelegram(log, config, formatAlertHtml(alert), db);
    if (result === "telegram") return result;
  }
  if (config.alertWebhookUrl !== "") {
    return dispatchWebhook(log, config, alert, db);
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

/** Writes the dedupe state so a redeploy does not re-announce an unchanged set. */
function persistStaleDedupe(db: FastifyInstance["db"]): void {
  const snapshot: PersistedWatchdogDedupe = {
    signature: lastStaleSignature,
    lastAlertAtMs: lastStaleAlertAtMs,
  };
  saveJobState(db, WATCHDOG_DEDUPE_STATE_KEY, snapshot);
}

/**
 * Restores the dedupe state at boot.
 *
 * Without this a redeploy mid-outage re-alerts immediately, which is the safe
 * direction — but "every single deploy re-announces" is not a safe direction,
 * it is an alarm that trains people to ignore it. The repeat interval still
 * bounds the noise: a restored signature whose repeat window has not elapsed
 * suppresses, exactly as an in-process one would.
 */
function hydrateStaleDedupe(db: FastifyInstance["db"]): void {
  const raw = loadJobState(db).get(WATCHDOG_DEDUPE_STATE_KEY);
  if (typeof raw !== "object" || raw === null) return;
  const { signature, lastAlertAtMs } = raw as Partial<PersistedWatchdogDedupe>;
  lastStaleSignature = typeof signature === "string" ? signature : null;
  lastStaleAlertAtMs = typeof lastAlertAtMs === "number" ? lastAlertAtMs : null;
}

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
  // Reap first: quarantined devices must be excluded before the stale set is
  // computed, otherwise this tick would still alert on the device it just muted.
  const reaped = quarantineNeverSeenDevices(app.db, config.deviceQuarantineSec);
  if (reaped.length > 0) {
    app.log.info(
      { job: "heartbeat_watchdog", count: reaped.length, deviceIds: reaped, quarantineSec: config.deviceQuarantineSec },
      "quarantined never-seen devices — muted, not revoked; any heartbeat clears them",
    );
  }
  const stale = findStaleDevices(app.db, config.watchdogStaleSec);
  if (stale.length === 0) {
    app.log.info({ job: "heartbeat_watchdog" }, "no stale devices");
    // A recovered set must not pin the next alert as "unchanged", so clear here
    // rather than comparing against an empty set forever.
    lastStaleSignature = null;
    lastStaleAlertAtMs = null;
    persistStaleDedupe(app.db);
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
    phones: stale.map((d) => d.phone_number),
    count: stale.length,
    threshold_sec: config.watchdogStaleSec,
    detected_at: new Date().toISOString(),
  };
  await dispatchAlert(app.log, config, alert, app.db);
  lastStaleSignature = signature;
  lastStaleAlertAtMs = nowMs;
  persistStaleDedupe(app.db);
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
  // Restore both counters before anything can dispatch or alert, so the first
  // tick after a deploy reports what was actually happening rather than a clean
  // slate. A fresh database simply has no rows, which is the old behaviour.
  hydrateSinkHealth(app.db);
  hydrateStaleDedupe(app.db);
  hydrateCanaryState(app.db);
  app.decorate("runWatchdog", () => watchdogTick(app));
  app.decorate("runCatchUpSweep", () => catchUpSweepTick(app));
  app.decorate("runBulkQueueTick", () => runBulkQueueTick(app));
  app.decorate("runStatsTick", () => runStatsTick(app));
  app.decorate("runAlertCanary", () => alertCanaryTick(app));

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
      if (config.alertCanaryEnabled) {
        cron.schedule(config.alertCanaryCron, () => {
          alertCanaryTick(app).catch((err) => app.log.error({ err }, "alert canary job failed"));
        });
      }
      app.log.info(
        {
          watchdogCron: config.watchdogCron,
          catchUpCron: config.catchUpCron,
          bulkQueueCron: config.bulkQueueCron,
          statsCron: config.statsCron,
          alertCanaryCron: config.alertCanaryEnabled ? config.alertCanaryCron : "disabled",
        },
        "job runner started",
      );
    })();
  }
}
