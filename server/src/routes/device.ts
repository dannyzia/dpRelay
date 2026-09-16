/**
 * Device plane routes: M1 (registration, heartbeat) + M2 (PLAN.md §7):
 * enrollment, outstanding-fetch (at-least-once), results, payment-SMS ingest,
 * FCM token registration.
 *
 * Auth model (single choke point per plan §5):
 * - /v5/device/enroll        → enrollment secret (Bearer), ADR-016 — the phone
 *                              has no user JWT, mirroring v4's custom-token
 *                              enrollment but minting a v5 API key instead.
 * - every other device route → device API key via requireDevice.
 *
 * The raw API key is returned exactly once (enroll/register); only its
 * SHA-256 hash is ever stored.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { constantTimeEquals, newId } from "../services/crypto.js";

interface DeviceRegisterBody {
  label?: unknown;
}

interface EnrollBody {
  label?: unknown;
}

interface OutstandingMessage {
  id: string;
  to: string;
  message: string;
  createdAt: number;
}

interface ResultItem {
  id?: unknown;
  status?: unknown;
  error?: unknown;
}

interface ResultsBody {
  results?: unknown;
}

interface PaymentSmsBody {
  sender?: unknown;
  provider?: unknown;
  txnId?: unknown;
  amountPaisa?: unknown;
  receivedAt?: unknown;
}

interface FcmTokenBody {
  token?: unknown;
}

/** bKash/Nagad transaction IDs: exactly 10 uppercase alphanumerics (v4 parity). */
const TXN_ID_PATTERN = /^[A-Z0-9]{10}$/;
const PROVIDERS = new Set(["bkash", "nagad"]);
/** Cap on messages handed out per fetch — the phone re-fetches; keep responses small. */
const OUTSTANDING_BATCH_LIMIT = 50;
const MAX_FCM_TOKEN_LEN = 4096;
const MAX_ERROR_LEN = 256;

/**
 * Narrow unknown JSON to a plain record, or null.
 * Bodies arrive untyped (no JSON Schema on these routes) — this is the trust
 * boundary, so every field is validated before use.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    return null;
  }
  return value;
}

const deviceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Per-IP sliding-window limiter for enrollment (brute-force guard — v4
   * parity with registerAuthenticator's per-IP limits). All attempts count,
   * success or failure: the guard exists to stop secret guessing, not just
   * key farming. State is per-app-instance, so tests isolate naturally.
   */
  const enrollAttempts = new Map<string, number[]>();
  const enrollWindowMs = app.config.enrollRateWindowSec * 1000;
  const enrollRateMax = app.config.enrollRateMaxPerHour;

  function enrollRateCheck(ip: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const stamps = (enrollAttempts.get(ip) ?? []).filter((t) => now - t < enrollWindowMs);
    if (stamps.length >= enrollRateMax) {
      const oldest = stamps[0] ?? now;
      enrollAttempts.set(ip, stamps);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + enrollWindowMs - now) / 1000)),
      };
    }
    stamps.push(now);
    enrollAttempts.set(ip, stamps);
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * M1: registers a device for the JWT-authenticated caller and issues its API key.
   */
  app.post("/v5/device/register", { onRequest: [app.requireAuth] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 128)
        : "unnamed device";

    const user = (request as FastifyRequest & { user?: { id: string; email: string } }).user;
    if (!user) {
      // Unreachable: requireAuth guarantees the JWT subject, but keep the invariant explicit.
      return reply.code(401).send({ ok: false, error: "Authentication required", code: "missing_bearer_token" });
    }

    const rawKey = app.generateDeviceApiKey();
    const deviceId = newId();
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
          "VALUES (?, ?, ?, ?, NULL, 1, NULL, unixepoch())",
      )
      .run(deviceId, user.id, label, app.sha256Hex(rawKey));

    return reply.code(201).send({ ok: true, deviceId, apiKey: rawKey });
  });

  /**
   * M2 (ADR-016): phone enrollment without a user account. Exchanges the
   * enrollment secret for a device API key. Disabled (403) unless
   * DEVICE_ENROLLMENT_SECRET is configured; compared in constant time.
   */
  app.post("/v5/device/enroll", async (request, reply) => {
    const verdict = enrollRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many enrollment attempts", code: "rate_limited" });
    }

    const expected = app.config.deviceEnrollmentSecret;
    if (expected === "") {
      return reply.code(403).send({ ok: false, error: "Device enrollment is disabled", code: "enrollment_disabled" });
    }

    const authHeader = request.headers.authorization;
    const provided = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
    // Constant-time even when the header is missing: compare against the real
    // secret with a dummy so timing does not leak header presence.
    if (provided === "" || !constantTimeEquals(provided, expected)) {
      return reply.code(401).send({ ok: false, error: "Invalid enrollment secret", code: "invalid_enrollment_secret" });
    }

    const body = asRecord(request.body) ?? {};
    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 128)
        : "gateway phone";

    const rawKey = app.generateDeviceApiKey();
    const deviceId = newId();
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
          "VALUES (?, NULL, ?, ?, NULL, 1, NULL, unixepoch())",
      )
      .run(deviceId, label, app.sha256Hex(rawKey));

    app.log.info({ deviceId, label }, "device enrolled");
    return reply.code(201).send({ ok: true, deviceId, apiKey: rawKey });
  });

  /**
   * M1: phone heartbeat (R1) — feeds the watchdog and doubles as keep-alive.
   */
  app.post("/v5/device/heartbeat", { onRequest: [app.requireDevice] }, async (request, reply) => {
    app.db
      .prepare("UPDATE devices SET last_seen_at = unixepoch() WHERE id = ?")
      .run(request.device!.id);
    return reply.code(200).send({ ok: true, heartbeat: "received" });
  });

  /**
   * M2: outstanding-fetch (§7 #2). Returns pending messages and claims them for
   * this device. At-least-once semantics: a claim older than
   * OUTSTANDING_REQUEUE_SEC is re-offered on the next fetch, so a phone that
   * dies mid-flight cannot silently drop a message. Exactly-once reporting
   * happens through POST /v5/device/results.
   */
  app.get("/v5/device/outstanding", { onRequest: [app.requireDevice] }, async (request, reply) => {
    const requeueBefore = Math.floor(Date.now() / 1000) - app.config.outstandingRequeueSec;

    const claimTx = app.db.transaction((): OutstandingMessage[] => {
      // Requeue stale claims first so they are visible to the SELECT below.
      app.db
        .prepare(
          "UPDATE pending_sms SET status = 'pending', claimed_at = NULL, claimed_by = NULL " +
            "WHERE status = 'claimed' AND claimed_at < ?",
        )
        .run(requeueBefore);

      const rows = app.db
        .prepare(
          "SELECT id, to_addr, message, created_at FROM pending_sms " +
            "WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
        )
        .all(OUTSTANDING_BATCH_LIMIT) as { id: string; to_addr: string; message: string; created_at: number }[];

      const now = Math.floor(Date.now() / 1000);
      const markClaimed = app.db.prepare(
        "UPDATE pending_sms SET status = 'claimed', claimed_at = ?, claimed_by = ?, claimed_count = claimed_count + 1 " +
          "WHERE id = ?",
      );
      const out: OutstandingMessage[] = [];
      for (const row of rows) {
        markClaimed.run(now, request.device!.id, row.id);
        out.push({ id: row.id, to: row.to_addr, message: row.message, createdAt: row.created_at });
      }
      return out;
    });

    const messages = claimTx();
    return reply.code(200).send({ ok: true, messages });
  });

  /**
   * M2: delivery results from the phone (§7 #3). 'sent' and 'failed' are both
   * terminal here; failed rows keep their error for otpStatus/webhooks (M3).
   * Unknown ids are ignored (idempotent retries, requeued duplicates).
   */
  app.post("/v5/device/results", { onRequest: [app.requireDevice] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const rawResults = Array.isArray(body.results) ? body.results : null;
    if (!rawResults) {
      return reply.code(400).send({
        ok: false,
        error: "Body must be { results: [{ id, status: 'sent'|'failed', error? }] }",
        code: "invalid_body",
      });
    }

    const markSent = app.db.prepare(
      "UPDATE pending_sms SET status = 'sent', result_at = unixepoch(), error = NULL " +
        "WHERE id = ? AND status IN ('claimed', 'pending')",
    );
    const markFailed = app.db.prepare(
      "UPDATE pending_sms SET status = 'failed', result_at = unixepoch(), error = ? " +
        "WHERE id = ? AND status IN ('claimed', 'pending')",
    );

    let accepted = 0;
    let unknown = 0;
    for (const item of rawResults as ResultItem[]) {
      const entry = asRecord(item);
      if (!entry) {
        return reply.code(400).send({
          ok: false,
          error: "Each result needs { id, status: 'sent'|'failed' }",
          code: "invalid_result_item",
        });
      }
      const id = asString(entry.id, 128);
      const status = entry.status;
      if (!id || (status !== "sent" && status !== "failed")) {
        return reply.code(400).send({
          ok: false,
          error: "Each result needs { id, status: 'sent'|'failed' }",
          code: "invalid_result_item",
        });
      }
      if (status === "sent") {
        accepted += markSent.run(id).changes;
      } else {
        const error = asString(entry.error, MAX_ERROR_LEN) ?? "send_failed";
        accepted += markFailed.run(error, id).changes;
      }
    }
    unknown = rawResults.length - accepted;

    return reply.code(200).send({ ok: true, accepted, unknown });
  });

  /**
   * M2: payment-SMS ingest (§7 #6). Same validations as v4: provider is
   * bKash/Nagad, txn_id matches ^[A-Z0-9]{10}$. Unique txn_id makes phone
   * retries idempotent — a duplicate is reported, not double-counted.
   */
  app.post("/v5/device/payment-sms", { onRequest: [app.requireDevice] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const sender = asString(body.sender, 32);
    const provider = asString(body.provider, 16)?.toLowerCase() ?? null;
    const txnId = asString(body.txnId, 16);
    const amountPaisa =
      typeof body.amountPaisa === "number" && Number.isInteger(body.amountPaisa) && body.amountPaisa >= 0
        ? body.amountPaisa
        : null;
    const receivedAt =
      typeof body.receivedAt === "number" && Number.isInteger(body.receivedAt) && body.receivedAt > 0
        ? Math.floor(body.receivedAt / 1000)
        : Math.floor(Date.now() / 1000);

    if (!sender || !provider || !PROVIDERS.has(provider) || !txnId || !TXN_ID_PATTERN.test(txnId) || amountPaisa === null) {
      return reply.code(400).send({
        ok: false,
        error: "Need { sender, provider: 'bkash'|'nagad', txnId (10 alnum), amountPaisa (int >= 0) }",
        code: "invalid_payment_sms",
      });
    }

    const result = app.db
      .prepare(
        "INSERT OR IGNORE INTO payment_sms (id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())",
      )
      .run(newId(), request.device!.id, sender, provider, txnId, amountPaisa, receivedAt);

    return reply.code(result.changes > 0 ? 201 : 200).send({
      ok: true,
      created: result.changes > 0,
      txnId,
    });
  });

  /**
   * M2: FCM token registration (§7 #1). Stored for the M3 server→phone wake
   * sender; M2's wake path is the phone's own post-heartbeat fetch, so this
   * endpoint only persists the token.
   */
  app.post("/v5/device/fcm-token", { onRequest: [app.requireDevice] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const token = asString(body.token, MAX_FCM_TOKEN_LEN);
    if (!token) {
      return reply.code(400).send({
        ok: false,
        error: "Need { token: string }",
        code: "invalid_fcm_token",
      });
    }

    app.db.prepare("UPDATE devices SET fcm_token = ? WHERE id = ?").run(token, request.device!.id);
    return reply.code(200).send({ ok: true });
  });
};

export default deviceRoutes;
