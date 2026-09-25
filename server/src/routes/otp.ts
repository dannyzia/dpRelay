/**
 * M3 OTP plane routes (PLAN.md §7): send, verify, status — the v4
 * sendOtp/verifyOtp/otpStatus behavioral parity, rebuilt on v5.
 *
 * Security model (per fable §IV–V and Addendum):
 * - App auth via requireApp (X-App-Id / X-App-Secret, hashed at rest).
 * - OTP stored as sha256(salt || otp) with a per-OTP salt — the plaintext code
 *   exists only in the outgoing SMS body and the caller's request, never on disk.
 * - Verify runs inside an IMMEDIATE transaction: attempt counting, lockout, and
 *   success marking are atomic against concurrent submissions.
 * - Kill switch (settings.kill_switch) halts sends instantly; verification of
 *   already-delivered codes continues to work while paused.
 * - FCM wake is best-effort: failure to wake falls back to the phone's
 *   reconcile fetch, so OTP delivery never depends on push delivery.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes, randomInt } from "node:crypto";
import { constantTimeEquals, newId, sha256Hex } from "../services/crypto.js";
import { asRecord, asString } from "../services/parse.js";
import { dispatchOtpStatusWebhooks, type OtpWebhookStatus } from "../services/webhooks.js";

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const OTP_LENGTH = 6;
const OTP_PATTERN = /^\d{6}$/;

interface OtpSessionRow {
  id: string;
  app_id: string;
  phone: string;
  otp_hash: string;
  salt: string;
  attempts: number;
  locked_until: number | null;
  expires_at: number;
  status: "pending" | "verified" | "expired";
  message_id: string | null;
  created_at: number;
  verified_at: number | null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const otpRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Per-phone resend cooldown (M3 tail, ISSUE-23): last send time per (app,
   * phone), in-memory like the other per-plane rate structures — it bounds SMS
   * spend, not correctness, and a restart resetting it merely allows one
   * immediate resend (the per-app session rate limit above still applies).
   * Pattern parity: bulk_phone_cooldowns caps re-alerts after confirmed bulk
   * delivery; this caps OTP re-sends to the SAME number within
   * OTP_RESEND_COOLDOWN_SEC regardless of session state.
   */
  const resendCooldown = new Map<string, number>();
  let resendSweepCounter = 0;

  /** Kill switch read (settings.kill_switch seeded by migration 001). */
  function killSwitchOn(): boolean {
    const row = app.db
      .prepare("SELECT value FROM settings WHERE key = 'kill_switch'")
      .get() as { value: string } | undefined;
    return row?.value === "true";
  }

  /** Newest FCM token across non-revoked devices (single-gateway deployment). */
  function gatewayFcmToken(): string | null {
    const row = app.db
      .prepare(
        "SELECT fcm_token FROM devices " +
          "WHERE revoked_at IS NULL AND fcm_token IS NOT NULL AND fcm_token != '' " +
          "ORDER BY last_seen_at DESC LIMIT 1",
      )
      .get() as { fcm_token: string } | undefined;
    return row?.fcm_token ?? null;
  }

  /**
   * Best-effort FCM wake. Push failure is never fatal: the phone's reconcile
   * fetch picks up outstanding messages on its next heartbeat cycle, so OTP
   * delivery does not depend on push delivery.
   */
  async function wakeGateway(): Promise<void> {
    if (app.config.fcmServiceAccountJson === "") {
      app.log.warn("FCM wake skipped: FCM_SERVICE_ACCOUNT_JSON not configured");
      return;
    }
    const token = gatewayFcmToken();
    if (!token) {
      app.log.warn("FCM wake skipped: no gateway device has registered an FCM token");
      return;
    }
    try {
      const { default: firebaseAdmin } = await import("firebase-admin");
      if (firebaseAdmin.apps.length === 0) {
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert(
            JSON.parse(app.config.fcmServiceAccountJson) as Record<string, unknown>,
          ),
        });
      }
      await firebaseAdmin.messaging().send({
        token,
        data: { kind: "outstanding" },
        android: { priority: "high" },
      });
    } catch (err) {
      app.log.warn({ err }, "FCM wake failed — reconcile fetch will pick up the message");
    }
  }

  app.post(
    "/v5/otp/send",
    { onRequest: [app.requireApp] },
    async (request, reply) => {
      if (killSwitchOn()) {
        return reply
          .code(503)
          .header("Retry-After", "60")
          .send({ ok: false, error: "SMS sending is paused", code: "sms_paused" });
      }

      const body = asRecord(request.body) ?? {};
      const phone = asString(body.phone, 20);
      if (!phone || !E164_PATTERN.test(phone)) {
        return reply.code(400).send({
          ok: false,
          error: "phone must be strict E.164, e.g. +8801XXXXXXXXX",
          code: "invalid_phone",
        });
      }

      const appRow = request.appRow!;
      const rate = app.db
        .prepare(
          "SELECT COUNT(*) AS n FROM otp_sessions " +
            "WHERE app_id = ? AND phone = ? AND created_at > unixepoch() - ?",
        )
        .get(appRow.id, phone, appRow.rateWindowSec) as { n: number };
      if (rate.n >= appRow.rateMaxPerPhone) {
        return reply
          .code(429)
          .header("Retry-After", String(appRow.rateWindowSec))
          .send({ ok: false, error: "Too many OTP requests for this number", code: "rate_limited" });
      }

      // Per-phone resend cooldown: runs AFTER the per-app session rate limit
      // (that one bounds session volume; this one bounds resend frequency for
      // a single number). Failure envelope mirrors rate_limited.
      const nowMs = Date.now();
      const cooldownMs = app.config.otpResendCooldownSec * 1000;
      const lastSendMs = resendCooldown.get(`${appRow.id}:${phone}`) ?? 0;
      if (nowMs - lastSendMs < cooldownMs) {
        const retryAfterSec = Math.max(1, Math.ceil((lastSendMs + cooldownMs - nowMs) / 1000));
        return reply
          .code(429)
          .header("Retry-After", String(retryAfterSec))
          .send({
            ok: false,
            error: `Please wait ${retryAfterSec}s before requesting another code for this number`,
            code: "resend_cooldown",
          });
      }
      resendCooldown.set(`${appRow.id}:${phone}`, nowMs);
      // Periodic sweep keeps the map bounded (slow-burn entries only; a small
      // scan every 64 sends is cheaper than a timestamp index per send).
      if (++resendSweepCounter % 64 === 0) {
        for (const [key, at] of resendCooldown) {
          if (nowMs - at >= cooldownMs) resendCooldown.delete(key);
        }
      }

      const otp = String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, "0");
      const salt = randomBytes(16).toString("hex");
      const otpHash = sha256Hex(salt + otp);
      const ts = nowSec();
      const expiresAt = ts + app.config.otpTtlSec;
      const sessionId = newId();
      const messageId = newId();

      // A newer send supersedes any still-pending session for the same number.
      // Insert order matters: pending_sms first (otp_sessions.message_id FK).
      const createSession = app.db.transaction(() => {
        app.db
          .prepare(
            "UPDATE otp_sessions SET status = 'expired' " +
              "WHERE app_id = ? AND phone = ? AND status = 'pending'",
          )
          .run(appRow.id, phone);
        app.db
          .prepare(
            "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
              "VALUES (?, ?, ?, ?, 'pending', ?)",
          )
          .run(
            messageId,
            appRow.appId,
            phone,
            `Your dP Relay verification code is ${otp}. Valid ${Math.round(app.config.otpTtlSec / 60)} minutes.`,
            ts,
          );
        app.db
          .prepare(
            "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, attempts, " +
              "locked_until, expires_at, status, message_id, created_at, verified_at) " +
              "VALUES (?, ?, ?, ?, ?, 0, NULL, ?, 'pending', ?, ?, NULL)",
          )
          .run(sessionId, appRow.id, phone, otpHash, salt, expiresAt, messageId, ts);
      });
      createSession();

      await wakeGateway();

      app.log.info({ sessionId, appId: appRow.appId }, "otp session created");
      return reply.code(201).send({ ok: true, sessionId, expiresAt });
    },
  );

  app.post(
    "/v5/otp/verify",
    { onRequest: [app.requireApp] },
    async (request, reply) => {
      const body = asRecord(request.body) ?? {};
      const phone = asString(body.phone, 20);
      const otp = asString(body.otp, OTP_LENGTH);
      if (!phone || !E164_PATTERN.test(phone)) {
        return reply.code(400).send({ ok: false, error: "phone must be strict E.164", code: "invalid_phone" });
      }
      if (!otp || !OTP_PATTERN.test(otp)) {
        return reply.code(400).send({ ok: false, error: "otp must be 6 digits", code: "invalid_otp_format" });
      }

      const appRow = request.appRow!;
      const ts = nowSec();
      const session = app.db
        .prepare(
          "SELECT * FROM otp_sessions " +
            "WHERE app_id = ? AND phone = ? AND status = 'pending' " +
            "ORDER BY created_at DESC LIMIT 1",
        )
        .get(appRow.id, phone) as OtpSessionRow | undefined;

      if (!session || session.expires_at <= ts) {
        if (session) {
          app.db.prepare("UPDATE otp_sessions SET status = 'expired' WHERE id = ?").run(session.id);
        }
        return reply.code(400).send({ ok: false, error: "No active OTP session for this number", code: "otp_expired" });
      }
      if (session.locked_until !== null && session.locked_until > ts) {
        return reply.code(423).send({
          ok: false,
          error: "Too many failed attempts — retry later",
          code: "otp_locked",
          retryAfterSec: session.locked_until - ts,
        });
      }

      // IMMEDIATE transaction: attempt counting + lockout + success marking are
      // atomic against concurrent verifications of the same session.
      const providedHash = sha256Hex(session.salt + otp);
      const verifyTx = app.db
        .transaction((row: OtpSessionRow) => {
          if (constantTimeEquals(providedHash, row.otp_hash)) {
            app.db
              .prepare(
                "UPDATE otp_sessions SET status = 'verified', verified_at = unixepoch() WHERE id = ?",
              )
              .run(row.id);
            return { verified: true as const, attempts: row.attempts, locked: false as const };
          }
          const attempts = row.attempts + 1;
          const locked = attempts >= app.config.otpMaxAttempts;
          app.db
            .prepare(
              "UPDATE otp_sessions SET attempts = ?, locked_until = " +
                "CASE WHEN ? THEN unixepoch() + ? ELSE locked_until END WHERE id = ?",
            )
            .run(attempts, locked ? 1 : 0, app.config.otpLockoutSec, row.id);
          return { verified: false as const, attempts, locked };
        })
        .immediate(session);

      if (verifyTx.verified) {
        // M3 gap fix: the otp.status contract advertises "verified" — apps
        // opted into webhooks get the same signed notification the results
        // route sends. Dispatch is best-effort by contract (never throws), so
        // verification semantics cannot be affected by the receiver.
        const messageId = session.message_id;
        if (messageId !== null) {
          const statuses = new Map<string, OtpWebhookStatus>();
          statuses.set(messageId, "verified");
          await dispatchOtpStatusWebhooks(app, [messageId], statuses);
        }
        return { ok: true, verified: true };
      }

      const fresh = app.db
        .prepare("SELECT attempts, locked_until FROM otp_sessions WHERE id = ?")
        .get(session.id) as { attempts: number; locked_until: number | null };
      if (verifyTx.locked || (fresh.locked_until !== null && fresh.locked_until > ts)) {
        return reply.code(423).send({
          ok: false,
          error: "Too many failed attempts — retry later",
          code: "otp_locked",
          retryAfterSec: (fresh.locked_until ?? ts) - ts,
        });
      }
      return reply.code(401).send({
        ok: false,
        error: "Invalid verification code",
        code: "invalid_otp",
        attemptsLeft: Math.max(0, app.config.otpMaxAttempts - fresh.attempts),
      });
    },
  );

  app.get(
    "/v5/otp/status",
    { onRequest: [app.requireApp] },
    async (request, reply) => {
      const query = request.query as { phone?: unknown };
      const phone = asString(query.phone, 20);
      if (!phone || !E164_PATTERN.test(phone)) {
        return reply.code(400).send({ ok: false, error: "phone query param must be strict E.164", code: "invalid_phone" });
      }

      const appRow = request.appRow!;
      const ts = nowSec();
      const session = app.db
        .prepare(
          "SELECT * FROM otp_sessions " +
            "WHERE app_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(appRow.id, phone) as OtpSessionRow | undefined;
      if (!session) {
        return reply.code(404).send({ ok: false, error: "No OTP session for this number", code: "not_found" });
      }

      let status = session.status;
      // Lazy expiry: a pending session past its expiry reports (and becomes) expired.
      if (status === "pending" && session.expires_at <= ts) {
        app.db.prepare("UPDATE otp_sessions SET status = 'expired' WHERE id = ?").run(session.id);
        status = "expired";
      }

      const attemptsLeft = Math.max(0, app.config.otpMaxAttempts - session.attempts);
      const locked = session.locked_until !== null && session.locked_until > ts;
      return {
        ok: true,
        status,
        expiresAt: session.expires_at,
        attemptsLeft: status === "pending" ? attemptsLeft : 0,
        lockedUntil: locked ? session.locked_until : null,
        verifiedAt: session.verified_at,
      };
    },
  );
};

export default otpRoutes;
