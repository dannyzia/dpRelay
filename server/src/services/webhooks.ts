/**
 * Signed webhook dispatch for the OTP plane (M3 tail, Rhizome ISSUE-7): when a
 * delivery result lands on POST /v5/device/results for a message that belongs
 * to an otp_session, notify the owning app at its registered webhook_url.
 *
 * Contract (own field names, per the payload-naming rule):
 * - Payload: { kind: "otp.status", appId, sessionId, phone, status, timestamp }
 * - Auth: X-DP-Signature: hex(HMAC-SHA256(rawBody, apps.webhook_secret)) — the
 *   app verifies with the secret returned at registration; the server must
 *   hold the key, which is why the plaintext column exists (005).
 * - Retry: up to WEBHOOK_RETRY_ATTEMPTS (3) attempts on non-2xx/transport
 *   errors with WEBHOOK_RETRY_DELAYS_MS backoff between them; every attempt is
 *   appended to webhook_deliveries (attempt number, response code, last error)
 *   and logged (warn per failed attempt with the error object or status code,
 *   info on success) — the audit table and the log stream must agree.
 * - Dispatch is fire-and-forget from the caller's perspective: route latency
 *   must not depend on the receiving app's availability.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FastifyInstance } from "fastify";
import { hmacSha256Hex, newId } from "./crypto.js";
import { dispatchAlert, type WebhookExhaustionAlert } from "../jobs.js";

/** Payload status values match pending_sms.result outcomes + final OTP verify state. */
export type OtpWebhookStatus = "sent" | "failed" | "verified";

export interface OtpWebhookPayload {
  kind: "otp.status";
  appId: string;
  sessionId: string;
  phone: string;
  status: OtpWebhookStatus;
  timestamp: number;
}

/** Retry attempts are counted per dispatch, including the first try. */
const WEBHOOK_RETRY_ATTEMPTS = 3;
/** Upper bound on URLs accepted for dispatch — SSRF blast-radius containment. */
const WEBHOOK_URL_MAX_LEN = 2048;
/** Cap on stored error text per attempt (matches other bounded columns). */
const MAX_WEBHOOK_ERROR_LEN = 256;

/** A dispatchable session: joined from otp_sessions + the owning apps row. */
interface SessionDispatchInfo {
  sessionId: string;
  /** Public appId — what receiving apps identify with (goes in the payload). */
  appId: string;
  /** Internal apps.id — satisfies webhook_deliveries.app_id's FK in audit rows. */
  appRowId: string;
  phone: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

/** One recorded attempt (also the shape of a webhook_deliveries row). */
export interface DeliveryAttemptRecord {
  attempt: number;
  responseCode: number | null;
  lastError: string | null;
  status: "delivered" | "failed";
}

/**
 * Resolves a pending_sms message to its OTP session and the owning app's
 * webhook config. Returns null when the message is not OTP-linked, the session
 * is gone, or the app has no webhook configured — "no webhook configured =
 * no dispatch" is enforced here, at the resolution boundary.
 */
export function resolveSessionDispatch(
  app: FastifyInstance,
  messageId: string,
): SessionDispatchInfo | null {
  const row = app.db
    .prepare(
      "SELECT s.id AS sessionId, a.app_id AS appId, a.id AS appRowId, s.phone AS phone, " +
        "a.webhook_url AS webhookUrl, a.webhook_secret AS webhookSecret " +
        "FROM otp_sessions s " +
        "JOIN apps a ON a.id = s.app_id " +
        "WHERE s.message_id = ? LIMIT 1",
    )
    .get(messageId) as SessionDispatchInfo | undefined;
  if (!row) return null;
  // No webhook configured = no dispatch (task constraint).
  if (!row.webhookUrl || !row.webhookSecret) return null;
  return row;
}

/**
 * Single POST with a hard per-attempt timeout. Rejects on transport errors and
 * timeouts; resolves with the HTTP status otherwise. The signature is computed
 * over the exact serialized body, so the receiver can verify byte-for-byte.
 */
function postWebhook(
  url: string,
  body: string,
  signature: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`invalid webhook_url: ${url.slice(0, WEBHOOK_URL_MAX_LEN)}`));
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
          "x-dp-signature": signature,
        },
        timeout: timeoutMs,
      },
      (res) => {
        // Drain the response so the socket is released back to the pool.
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`webhook timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Consecutive exhausted dispatches per app (keyed by internal apps.id), tracked
 * across dispatches. Held per Fastify instance in a WeakMap:
 * - In-memory by design — it is a re-armable alarm, not durable state. After a
 *   process restart the next exhaustion re-triggers the alert, which is the
 *   safe failure direction (at-least-once alerting on a channel that is itself
 *   about outages).
 * - Single-process deployment (constraint R3) makes a process-local counter
 *   the correct scope; DB-backed counts would couple alerting to migrations.
 * - Per-instance keying keeps independent app builds (tests) isolated.
 * Any success resets the app's count (re-arms the alert for the next outage).
 */
const exhaustionCounters = new WeakMap<FastifyInstance, Map<string, number>>();

/**
 * Runs once per exhausted dispatch: bumps the app's consecutive-exhaustion
 * count and fires the ops alert channel (log + ALERT_WEBHOOK_URL) when the
 * threshold is crossed. Alerting is best-effort and awaited like dispatch
 * itself; it must never fail the triggering request.
 */
async function onDispatchExhausted(app: FastifyInstance, info: SessionDispatchInfo, lastError: string | null): Promise<void> {
  let counters = exhaustionCounters.get(app);
  if (!counters) {
    counters = new Map();
    exhaustionCounters.set(app, counters);
  }
  const previous = counters.get(info.appRowId) ?? 0;
  const consecutive = previous + 1;
  counters.set(info.appRowId, consecutive);

  const threshold = app.config.webhookExhaustionAlertThreshold;
  if (consecutive < threshold) {
    return;
  }

  // Re-alert on every threshold-and-beyond exhaustion: a dead receiver keeps
  // ringing while it stays dead. Any successful delivery resets the counter
  // (re-arms the alert for the next outage episode).
  try {
    await dispatchAlert(app.log, app.config, {
      type: "webhook_exhaustion",
      appId: info.appId,
      consecutiveFailures: consecutive,
      threshold,
      lastSessionId: info.sessionId,
      lastError: lastError ?? `all ${WEBHOOK_RETRY_ATTEMPTS} attempts rejected (no transport error)`,
      detected_at: new Date().toISOString(),
    });
  } catch (err) {
    // dispatchAlert already logs its own failures; this guard only keeps an
    // alerting bug from ever propagating into the dispatch path.
    app.log.error({ err, appId: info.appId }, "exhaustion alert channel threw unexpectedly");
  }
}

/**
 * Dispatches one OTP status webhook with retry, recording every attempt.
 * @returns All attempt records (at least one), plus the final disposition.
 */
export async function dispatchWebhook(
  app: FastifyInstance,
  info: SessionDispatchInfo,
  status: OtpWebhookStatus,
): Promise<{ delivered: boolean; attempts: DeliveryAttemptRecord[] }> {
  const payload: OtpWebhookPayload = {
    kind: "otp.status",
    appId: info.appId,
    sessionId: info.sessionId,
    phone: info.phone,
    status,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const rawBody = JSON.stringify(payload);
  const signature = hmacSha256Hex(info.webhookSecret!, rawBody);
  const retryDelays = app.config.webhookRetryDelaysMs
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);

  const insertRow = app.db.prepare(
    "INSERT INTO webhook_deliveries (id, session_id, app_id, webhook_url, status, attempt, attempts_max, " +
      "created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, unixepoch())",
  );
  const finalizeRow = app.db.prepare(
    "UPDATE webhook_deliveries SET status = ?, response_code = ?, last_error = ?, delivered_at = ? WHERE id = ?",
  );

  const attempts: DeliveryAttemptRecord[] = [];
  let delivered = false;
  for (let attempt = 1; attempt <= WEBHOOK_RETRY_ATTEMPTS; attempt++) {
    const deliveryId = newId();
    insertRow.run(deliveryId, info.sessionId, info.appRowId, info.webhookUrl!.slice(0, WEBHOOK_URL_MAX_LEN), attempt, WEBHOOK_RETRY_ATTEMPTS);
    let responseCode: number | null = null;
    let lastError: string | null = null;
    let transportError: unknown;
    try {
      responseCode = await postWebhook(
        info.webhookUrl!,
        rawBody,
        signature,
        app.config.webhookTimeoutMs,
      );
      delivered = responseCode >= 200 && responseCode < 300;
    } catch (err) {
      transportError = err;
      lastError =
        err instanceof Error ? err.message.slice(0, MAX_WEBHOOK_ERROR_LEN) : "unknown webhook error";
    }

    finalizeRow.run(
      delivered ? "delivered" : "failed",
      responseCode,
      lastError,
      delivered ? Math.floor(Date.now() / 1000) : null,
      deliveryId,
    );
    attempts.push({ attempt, responseCode, lastError, status: delivered ? "delivered" : "failed" });

    if (delivered) {
      app.log.info(
        { appId: info.appId, sessionId: info.sessionId, status, attempt, responseCode },
        "webhook delivery attempt succeeded",
      );
      // Any success re-arms the exhaustion alert for the next outage episode.
      exhaustionCounters.get(app)?.delete(info.appRowId);
      break;
    }
    // Structured failure log per attempt: the webhook_deliveries row is the
    // durable audit record, but the same outcome must be visible in the log
    // stream with full context — never swallowed silently.
    if (lastError !== null) {
      app.log.warn(
        { appId: info.appId, sessionId: info.sessionId, status, attempt, err: transportError },
        "webhook delivery attempt failed with transport error",
      );
    } else {
      app.log.warn(
        { appId: info.appId, sessionId: info.sessionId, status, attempt, responseCode },
        "webhook delivery attempt rejected with non-2xx status",
      );
    }
    if (attempt < WEBHOOK_RETRY_ATTEMPTS && retryDelays.length > 0) {
      const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 0;
      await sleep(delay);
    }
  }

  if (!delivered) {
    app.log.error(
      { appId: info.appId, sessionId: info.sessionId, attempts: attempts.length },
      "webhook dispatch failed after all retries",
    );
    // Best-effort dead-receiver notice on the shared alert channel; never fails
    // the dispatch (and therefore never the triggering request either).
    await onDispatchExhausted(app, info, attempts[attempts.length - 1]?.lastError ?? null);
  }
  return { delivered, attempts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Entry point used by the results route: resolves the session for each accepted
 * message and dispatches when an app webhook is configured. Never throws — a
 * webhook failure must not fail the phone's results POST (the queue state is
 * already committed; dispatch is a notification, not a transaction step).
 */
export async function dispatchOtpStatusWebhooks(
  app: FastifyInstance,
  acceptedMessageIds: string[],
  statuses: Map<string, OtpWebhookStatus>,
): Promise<void> {
  for (const messageId of acceptedMessageIds) {
    const info = resolveSessionDispatch(app, messageId);
    if (!info) continue;
    const status = statuses.get(messageId) ?? "sent";
    try {
      const result = await dispatchWebhook(app, info, status);
      app.log.info(
        { appId: info.appId, sessionId: info.sessionId, status, delivered: result.delivered },
        "otp status webhook dispatched",
      );
    } catch (err) {
      // The results POST must not fail on dispatch problems, so this catch
      // remains — but it is loud and structured: unexpected errors are logged
      // as full error objects with the dispatch target attached, and every
      // attempt that got past resolution is already recorded in
      // webhook_deliveries (last_error included). Nothing drops silently.
      app.log.error(
        {
          err,
          messageId,
          appId: info.appId,
          sessionId: info.sessionId,
          webhookUrl: info.webhookUrl,
        },
        "unexpected webhook dispatch failure — audit rows record any attempts",
      );
    }
  }
}
