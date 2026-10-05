/**
 * Durable job-runner state, backed by the `job_state` table (migration 011).
 *
 * The watchdog and the alert sinks both carry state that must outlive the
 * process: failure counters that an operator needs to see have been failing,
 * and a dedupe signature that stops the watchdog re-announcing the same stale
 * set on every tick. Holding either in a module variable means every redeploy
 * silently resets them to "healthy", which is the one direction a monitoring
 * signal must never drift.
 *
 * Reads are tolerant by design. A corrupt or partially-written row must not
 * take the job runner down — these helpers return null/ignore rather than
 * throw, because a state table that can crash boot is worse than a state table
 * that forgets.
 */
import type { FastifyInstance } from "fastify";

type Db = FastifyInstance["db"];

/** Row holding every alert sink's counters, as one JSON object. */
export const ALERT_SINK_STATE_KEY = "alert_sink_health";
/** Row holding the watchdog's stale-alert dedupe signature and last alert time. */
export const WATCHDOG_DEDUPE_STATE_KEY = "watchdog_stale_dedupe";
/** Row holding the alert canary's last delivery receipt and failure counters. */
export const ALERT_CANARY_STATE_KEY = "alert_canary";

/**
 * One sink's persisted health.
 *
 * `lastError` is absent on purpose and must stay that way: it carries the
 * failing URL or response body, and this row is read on every boot. The
 * `/health/alerts` endpoint withholds the same field for the same reason.
 */
export interface PersistedSinkHealth {
  consecutiveFailures: number;
  degradedSince: string | null;
}

/** The watchdog dedupe state that survives a restart. */
export interface PersistedWatchdogDedupe {
  signature: string | null;
  lastAlertAtMs: number | null;
}

/**
 * The alert canary's persisted delivery evidence.
 *
 * `lastMessageId` is Telegram's own id for the last message it accepted, and it
 * is the reason this state is durable rather than in-process: it is the only
 * artifact that proves the channel delivered. A canary that forgets its last
 * receipt on every deploy cannot answer "has this channel worked recently?",
 * which is the exact question it exists to answer.
 *
 * No failure detail is stored here, for the same reason PersistedSinkHealth
 * omits it: this row is read on every boot and must not carry a URL or a
 * response body.
 */
export interface PersistedAlertCanary {
  /** When a receipt last landed; null until the first successful canary. */
  lastReceiptAtMs: number | null;
  /** Telegram's message id for that receipt; null until one lands. */
  lastMessageId: number | null;
  /** When the canary last attempted a send; null until the first attempt. */
  lastAttemptAtMs: number | null;
  /** When the canary last failed to obtain a receipt. */
  lastFailureAtMs: number | null;
  /** Consecutive attempts without a receipt; reset by the first one that lands. */
  consecutiveFailures: number;
}

/** Reads every persisted job-state row. Unparseable rows are skipped, not thrown. */
export function loadJobState(db: Db): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = db.prepare("SELECT key, value FROM job_state").all() as Array<{
      key: string;
      value: string;
    }>;
  } catch {
    // A pre-011 database (or one mid-migration) simply has no state yet.
    return out;
  }
  for (const row of rows) {
    try {
      out.set(row.key, JSON.parse(row.value));
    } catch {
      // Skip the bad row rather than fail boot; the affected counter restarts
      // clean, which is the same outcome as before this table existed.
    }
  }
  return out;
}

/** Writes one job-state row. Best-effort: a failed write must not break dispatch. */
export function saveJobState(db: Db, key: string, value: unknown): void {
  try {
    db.prepare(
      "INSERT INTO job_state (key, value, updated_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
    ).run(key, JSON.stringify(value));
  } catch {
    // Swallowed deliberately: this is called from the alerting path, whose whole
    // contract is that a failure must never escalate into an outage. The
    // in-memory counter still advances, so the transition is still logged.
  }
}
