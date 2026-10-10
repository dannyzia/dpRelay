/**
 * User-plane auth routes (M1): register, login, refresh.
 * All failures return the structured { ok: false, error, code } envelope.
 *
 * STAGE F3 (ISSUE-81) adds real customer auth for the web-v5 dashboard ON THE
 * SAME PATHS, without breaking the M1 JWT contract (see the additive-hybrid
 * decision on ISSUE-81):
 * - register/login now hash with scrypt (new hashes; stored Argon2 PHC keeps
 *   verifying), enforce the ordered 10-char minimum, are rate-limited per IP,
 *   and set an HttpOnly session cookie. Their response envelopes are preserved
 *   byte-for-byte so the legacy dashboard/ + web/ consumers and the existing
 *   auth.test.ts / m3-tails.test.ts suites keep passing unmodified.
 * - New routes: POST /v5/auth/logout, GET /v5/auth/me, POST+GET /v5/auth/apps,
 *   POST /v5/auth/apps/link — all session-cookie based.
 * - /v5/auth/refresh is untouched (M1 contract).
 */
import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  constantTimeEquals,
  generateAppCredentials,
  generateDeviceEnrollmentSecret,
  hashPasswordScrypt,
  newId,
  sha256Hex,
  verifyStoredPassword,
} from "../services/crypto.js";
import {
  generateEmailToken,
  hashEmailToken,
  isMailConfigured,
  resetEmailBody,
  sendMail,
  verificationEmailBody,
} from "../services/mailer.js";
import {
  readSessionCookie,
  requireSession as requireSessionGuard,
  SESSION_COOKIE,
  type SessionUser,
} from "../services/session.js";

/** RFC 5322-lite email shape: local@domain.tld, no spaces. Full validation is deliverability, not syntax. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** F3 (ISSUE-81): minimum raised 8 → 10 by owner order; cap at 128 to bound KDF work per request. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

/**
 * Format-valid scrypt hash of an unguessable value, burned on the login path
 * when no user row exists so the KDF cost (and therefore response timing) is
 * identical for unknown emails and wrong passwords.
 */
const DUMMY_SCRYPT_HASH = "scrypt:N=32768,r=8,p=1:abababababababababababababababab:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

/** SHA-256 of a fixed string, compared when the link target row is missing (constant-time miss path). */
const DUMMY_APP_DIGEST = sha256Hex("dprelay-auth-link-dummy");

interface RegisterBody {
  email?: unknown;
  password?: unknown;
}
interface LoginBody {
  email?: unknown;
  password?: unknown;
}
interface RefreshBody {
  refreshToken?: unknown;
}
interface LinkBody {
  appId?: unknown;
  appSecret?: unknown;
}
interface NameBody {
  name?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Current unixepoch seconds (session expiry comparisons). */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Per-IP sliding-window limiter for the customer-auth surface (register,
   * login, link) — brute-force guard for a shared email+password endpoint.
   * All attempts count, success or failure. Per-instance state isolates tests.
   */
  const authAttempts = new Map<string, number[]>();
  const authWindowMs = app.config.authRateWindowSec * 1000;
  const authRateMax = app.config.authRateMaxPerHour;

  function authRateCheck(ip: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const stamps = (authAttempts.get(ip) ?? []).filter((t) => now - t < authWindowMs);
    if (stamps.length >= authRateMax) {
      const oldest = stamps[0] ?? now;
      authAttempts.set(ip, stamps);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + authWindowMs - now) / 1000)),
      };
    }
    stamps.push(now);
    authAttempts.set(ip, stamps);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Sets the session cookie on a response (HttpOnly + Secure + SameSite=Lax). */
  function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${app.config.sessionTtlSec}`,
    );
  }

  /** Expires the session cookie (logout). Max-Age=0 makes the browser drop it. */
  function clearSessionCookie(reply: FastifyReply): void {
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    );
  }

  /**
   * Creates a hashed session row and returns the raw token — which exists only
   * in the Set-Cookie header, never in the DB or logs (refresh_tokens parity).
   */
  function createSession(userId: string): string {
    const raw = randomBytes(32).toString("base64url");
    app.db
      .prepare(
        "INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at) " +
          "VALUES (?, ?, ?, unixepoch() + ?, unixepoch())",
      )
      .run(newId(), userId, sha256Hex(raw), app.config.sessionTtlSec);
    return raw;
  }

  /**
   * Session guard for the F3/F9 routes: delegates to the shared service
   * (STAGE F9 — billing's wallet-buy path resolves sessions identically)
   * and keeps the send-401-then-return-null contract every route here is
   * written against.
   */
  function requireSession(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
    return requireSessionGuard(app.db, request, reply);
  }

  app.post("/v5/auth/register", async (request, reply) => {
    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }

    const body = (request.body ?? {}) as RegisterBody;
    const { email, password } = body;

    if (!isNonEmptyString(email) || !EMAIL_RE.test(email.trim())) {
      return reply.code(400).send({ ok: false, error: "Valid email required", code: "invalid_email" });
    }
    if (!isNonEmptyString(password) || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return reply.code(400).send({
        ok: false,
        error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
        code: "invalid_password",
      });
    }

    const normalized = email.trim().toLowerCase();
    const existing = app.db.prepare("SELECT id FROM users WHERE email = ?").get(normalized);
    if (existing) {
      return reply.code(409).send({ ok: false, error: "Email already registered", code: "email_taken" });
    }

    // F3: new hashes are scrypt (owner-ordered, node:crypto); rows minted by
    // the M1 Argon2 flow keep verifying through verifyStoredPassword's dispatch.
    const userId = newId();
    const passwordHash = await hashPasswordScrypt(password);
    app.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, unixepoch())")
      .run(userId, normalized, passwordHash);

    // Additive: a session cookie now comes with the M1 { ok: true } envelope,
    // so the dashboard is signed in immediately after signup while legacy
    // register consumers (which ignore cookies) see no contract change.
    setSessionCookie(reply, createSession(userId));

    // F3 amendment: best-effort verification email. Mail failures NEVER fail
    // registration — the feature disables cleanly (ordered) and the user can
    // resend from the dashboard once SMTP is configured.
    try {
      if (isMailConfigured(app.db) && app.config.dashboardBaseUrl !== "") {
        const raw = createEmailToken(userId, "verify", app.config.emailVerifyTtlSec);
        void sendMail(
          app.db,
          app.config.jwtSecret,
          normalized,
          "Confirm your dP Relay email",
          verificationEmailBody(app.config.dashboardBaseUrl, raw),
        ).catch((err: unknown) => app.log.warn({ err }, "verification email dispatch failed"));
      }
    } catch (err) {
      app.log.warn({ err }, "verification email scheduling failed");
    }
    return reply.code(201).send({ ok: true });
  });

  app.post("/v5/auth/login", async (request, reply) => {
    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }

    const body = (request.body ?? {}) as LoginBody;
    const { email, password } = body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return reply.code(400).send({
        ok: false,
        error: "email and password are required",
        code: "invalid_request",
      });
    }

    const normalized = email.trim().toLowerCase();
    const row = app.db
      .prepare("SELECT id, email, password_hash, disabled FROM users WHERE email = ?")
      .get(normalized) as
      | { id: string; email: string; password_hash: string; disabled: number }
      | undefined;

    // One verifier for both hash generations; the dummy hash equalizes timing
    // on the unknown-email path (order: constant-time verify, generic errors).
    const passwordOk = await verifyStoredPassword(row?.password_hash ?? DUMMY_SCRYPT_HASH, password);
    if (!row || !passwordOk || row.disabled !== 0) {
      // Unknown email, wrong password, and disabled account share one envelope
      // so probing cannot distinguish registered addresses.
      return reply.code(401).send({ ok: false, error: "Invalid credentials", code: "invalid_credentials" });
    }

    setSessionCookie(reply, createSession(row.id));

    // M1 JWT contract preserved verbatim for legacy dashboard/ + web/ clients.
    const accessToken = app.mintAccessToken({ id: row.id, email: row.email });
    const refreshToken = app.createRefreshToken(row.id, app.config.refreshTokenTtlSec);
    return reply.code(200).send({ ok: true, accessToken, refreshToken });
  });

  app.post("/v5/auth/refresh", async (request, reply) => {
    const body = (request.body ?? {}) as RefreshBody;
    const { refreshToken } = body;
    if (!isNonEmptyString(refreshToken)) {
      return reply.code(400).send({
        ok: false,
        error: "refreshToken is required",
        code: "invalid_request",
      });
    }

    const row = app.peekRefreshToken(refreshToken);
    if (!row) {
      return reply.code(401).send({
        ok: false,
        error: "Invalid, expired, or revoked refresh token",
        code: "invalid_refresh_token",
      });
    }

    // Rotation: the presented token is single-use — revoke it, issue a fresh pair.
    app.revokeRefreshToken(row.id);

    const user = app.db.prepare("SELECT id, email FROM users WHERE id = ?").get(row.user_id) as
      | { id: string; email: string }
      | undefined;
    if (!user) {
      return reply.code(401).send({
        ok: false,
        error: "User no longer exists",
        code: "invalid_refresh_token",
      });
    }

    const accessToken = app.mintAccessToken(user);
    const newRefreshToken = app.createRefreshToken(user.id, app.config.refreshTokenTtlSec);
    return reply.code(200).send({ ok: true, accessToken, refreshToken: newRefreshToken });
  });

  /**
   * F3 (ISSUE-81): ends the dashboard session. Idempotent — a missing or
   * already-dead cookie still clears. The session ROW is deleted, not just the
   * cookie, so a token copied before logout dies with the browser it left.
   */
  app.post("/v5/auth/logout", async (request, reply) => {
    const raw = readSessionCookie(request);
    if (raw !== null) {
      app.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(sha256Hex(raw));
    }
    clearSessionCookie(reply);
    return reply.code(200).send({ ok: true });
  });

  /**
   * F3 (ISSUE-81): identifies the signed-in customer. No app-plane data here —
   * the frontend follows up with GET /v5/auth/apps for the owned list.
   */
  app.get("/v5/auth/me", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const row = app.db.prepare("SELECT created_at FROM users WHERE id = ?").get(session.user.id) as
      | { created_at: number }
      | undefined;
    const verified = app.db.prepare("SELECT email_verified_at FROM users WHERE id = ?").get(session.user.id) as
      | { email_verified_at: number | null }
      | undefined;
    // emailVerifiedAt is ADDITIVE to the F3 /me contract (soft verification):
    // null = not verified; login is never gated on it.
    return reply.code(200).send({
      ok: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        createdAt: row?.created_at ?? null,
        emailVerifiedAt: verified?.email_verified_at ?? null,
      },
    });
  });

  /**
   * STAGE F9 (ISSUE-88): one atomic provision of a company + its SINGLE app
   * (1:1 enforced by the partial-UNIQUE index on apps.company_id, migration
   * 017) + the trial grant — now ONCE PER USER into the user_credits WALLET
   * (supersedes ISSUE-77's once-per-app invariant for owned apps; flagged on
   * the hub per AC). The wallet row's trial_granted_at is the re-grant
   * marker, and the grant only ever runs inside this transaction — a second
   * company cannot farm a second trial. appSecret + deviceEnrollmentSecret
   * are returned EXACTLY once (to the caller); only digests are persisted.
   */
  function provisionCompany(
    userId: string,
    companyName: string | null,
  ): {
    companyId: string;
    appId: string;
    appSecret: string;
    deviceEnrollmentSecret: string;
    name: string;
    trial: { otpSms: number; bulkSms: number; expiresAt: number } | null;
  } {
    const { appId, appSecret } = generateAppCredentials();
    // STAGE F7 (ISSUE-87): every app also gets a per-app device enrollment
    // secret (same one-time contract as appSecret — digests at rest only).
    const deviceEnrollmentSecret = generateDeviceEnrollmentSecret();
    const companyId = newId();
    const appRowId = newId();
    const finalName = companyName ?? appId;
    const trialCount = app.config.trialSmsCount;
    const trialTtlSec = app.config.trialSmsTtlDays * 24 * 60 * 60;
    const trialExpiresAt = nowSec() + trialTtlSec;
    let trialGranted = false;

    app.db.transaction(() => {
      app.db
        .prepare(
          "INSERT INTO companies (id, owner_user_id, name, created_at, disabled) " +
            "VALUES (?, ?, ?, unixepoch(), 0)",
        )
        .run(companyId, userId, finalName);
      app.db
        .prepare(
          "INSERT INTO apps (id, app_id, app_secret_hash, device_enrollment_secret_hash, " +
            "name, owner_user_id, company_id, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())",
        )
        .run(
          appRowId,
          appId,
          app.sha256Hex(appSecret),
          app.sha256Hex(deviceEnrollmentSecret),
          finalName,
          userId,
          companyId,
        );
      if (trialCount > 0) {
        const existing = app.db
          .prepare("SELECT trial_granted_at FROM user_credits WHERE user_id = ?")
          .get(userId) as { trial_granted_at: number | null } | undefined;
        if (existing === undefined || existing.trial_granted_at === null) {
          app.db
            .prepare(
              // trial_* snapshot (ISSUE-84 parity): the ledger's kind=trial
              // rows read these — the balance itself is spent away and proves
              // nothing. Upsert (not plain INSERT): a pre-existing wallet row
              // (e.g. from an approved buy) gains the trial without losing
              // anything — trial_granted_at then blocks every later grant.
              "INSERT INTO user_credits (user_id, otp_sms_remaining, bulk_sms_remaining, " +
                "otp_expires_at, bulk_expires_at, trial_sms_granted, trial_granted_at, updated_at) " +
                "VALUES (?, ?, ?, unixepoch() + ?, unixepoch() + ?, ?, unixepoch(), unixepoch()) " +
                "ON CONFLICT(user_id) DO UPDATE SET " +
                "otp_sms_remaining = otp_sms_remaining + excluded.otp_sms_remaining, " +
                "bulk_sms_remaining = bulk_sms_remaining + excluded.bulk_sms_remaining, " +
                "otp_expires_at = MAX(COALESCE(otp_expires_at, 0), excluded.otp_expires_at), " +
                "bulk_expires_at = MAX(COALESCE(bulk_expires_at, 0), excluded.bulk_expires_at), " +
                "trial_sms_granted = excluded.trial_sms_granted, " +
                "trial_granted_at = excluded.trial_granted_at, updated_at = excluded.updated_at",
            )
            .run(userId, trialCount, trialCount, trialTtlSec, trialTtlSec, trialCount);
          trialGranted = true;
        }
      }
    })();

    return {
      companyId,
      appId,
      appSecret,
      deviceEnrollmentSecret,
      name: finalName,
      trial: trialGranted ? { otpSms: trialCount, bulkSms: trialCount, expiresAt: trialExpiresAt } : null,
    };
  }

  /**
   * F3 (ISSUE-81) + STAGE F9 (ISSUE-88): self-serve registration. The
   * response contract is preserved (appId/appSecret/deviceEnrollmentSecret/
   * name/trial shown once); internally every self-serve app is now
   * company-backed (1:1) and the trial lands in the user WALLET, once per
   * user. `company` is additive to the 201 envelope.
   */
  app.post("/v5/auth/apps", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;

    const body = (request.body ?? {}) as NameBody;
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim().slice(0, 128)
        : null;

    const created = provisionCompany(session.user.id, name);
    app.log.info(
      { appId: created.appId, companyId: created.companyId, userId: session.user.id, trialSms: created.trial?.otpSms ?? 0 },
      "self-serve company+app registered",
    );
    return reply.code(201).send({
      ok: true,
      appId: created.appId,
      appSecret: created.appSecret,
      deviceEnrollmentSecret: created.deviceEnrollmentSecret,
      name: created.name,
      company: { id: created.companyId, name: created.name },
      trial: created.trial,
    });
  });

  /**
   * STAGE F9 (ISSUE-88): creates a company + its one app (1:1, database-
   * enforced) and applies the first-time trial to the user WALLET. Secrets
   * are shown exactly once here.
   */
  app.post("/v5/auth/companies", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const body = (request.body ?? {}) as NameBody;
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim().slice(0, 128)
        : null;
    if (name === null) {
      return reply.code(400).send({ ok: false, error: "Company name is required", code: "invalid_name" });
    }
    const created = provisionCompany(session.user.id, name);
    app.log.info(
      { companyId: created.companyId, appId: created.appId, userId: session.user.id },
      "company created",
    );
    return reply.code(201).send({
      ok: true,
      company: { id: created.companyId, name: created.name, disabled: false, createdAt: nowSec() },
      app: {
        appId: created.appId,
        appSecret: created.appSecret,
        deviceEnrollmentSecret: created.deviceEnrollmentSecret,
        name: created.name,
      },
      trial: created.trial,
    });
  });

  /**
   * STAGE F9 (ISSUE-88): the signed-in user's companies, each with its app
   * summary + the F7 gateway number (the phone bound to the company's app).
   * Secrets are never re-served — the projection carries no hash material
   * (apps-list parity); credentials are recoverable via /v5/auth/apps/link.
   */
  app.get("/v5/auth/companies", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const rows = app.db
      .prepare(
        "SELECT c.id, c.name, c.created_at, c.disabled, a.app_id, a.name AS app_name, " +
          "a.revoked_at, d.phone_number AS gateway_number " +
          "FROM companies c JOIN apps a ON a.company_id = c.id " +
          "LEFT JOIN devices d ON d.app_id = a.id " +
          "WHERE c.owner_user_id = ? ORDER BY c.created_at DESC, c.id",
      )
      .all(session.user.id) as Array<{
      id: string;
      name: string;
      created_at: number;
      disabled: number;
      app_id: string;
      app_name: string;
      revoked_at: number | null;
      gateway_number: string | null;
    }>;
    return reply.code(200).send({
      ok: true,
      companies: rows.map((r) => ({
        id: r.id,
        name: r.name,
        disabled: r.disabled !== 0,
        createdAt: r.created_at,
        gatewayNumber: r.gateway_number,
        app: { appId: r.app_id, name: r.app_name, revoked: r.revoked_at !== null },
      })),
    });
  });

  /** STAGE F9 (ISSUE-88): renames a company the caller owns (404 otherwise). */
  app.patch("/v5/auth/companies/:id", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const params = (request.params ?? {}) as { id?: unknown };
    const companyId = typeof params.id === "string" ? params.id : "";
    const body = (request.body ?? {}) as NameBody;
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim().slice(0, 128)
        : null;
    if (name === null) {
      return reply.code(400).send({ ok: false, error: "Company name is required", code: "invalid_name" });
    }
    const updated = app.db
      .prepare("UPDATE companies SET name = ? WHERE id = ? AND owner_user_id = ?")
      .run(name, companyId, session.user.id);
    if (updated.changes !== 1) {
      return reply.code(404).send({ ok: false, error: "Company not found", code: "company_not_found" });
    }
    return reply.code(200).send({ ok: true, company: { id: companyId, name } });
  });

  /**
   * STAGE F9 (ISSUE-88): withholds a company — its app's sends stop at the
   * requireApp choke point (403 company_disabled, distinct from owner-level
   * account_withheld). Idempotent; re-enablement is the operator's plane.
   */
  app.post("/v5/auth/companies/:id/disable", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const params = (request.params ?? {}) as { id?: unknown };
    const companyId = typeof params.id === "string" ? params.id : "";
    const updated = app.db
      .prepare("UPDATE companies SET disabled = 1 WHERE id = ? AND owner_user_id = ?")
      .run(companyId, session.user.id);
    if (updated.changes !== 1) {
      return reply.code(404).send({ ok: false, error: "Company not found", code: "company_not_found" });
    }
    app.log.info({ companyId, userId: session.user.id }, "company disabled by owner");
    return reply.code(200).send({ ok: true, company: { id: companyId, disabled: true } });
  });

  /**
   * STAGE F9 (ISSUE-88): the signed-in user's WALLET balance — what every
   * company app draws from. A user with no wallet row yet reports zeros
   * (fail-closed read, same envelope shape as the app-plane credits route).
   */
  app.get("/v5/auth/wallet", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const row = app.db
      .prepare(
        "SELECT otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, " +
          "last_transaction_id, purchased_at FROM user_credits WHERE user_id = ?",
      )
      .get(session.user.id) as
      | {
          otp_sms_remaining: number;
          bulk_sms_remaining: number;
          otp_expires_at: number | null;
          bulk_expires_at: number | null;
          last_transaction_id: string | null;
          purchased_at: number | null;
        }
      | undefined;
    return reply.code(200).send({
      ok: true,
      wallet: {
        otpSmsRemaining: row?.otp_sms_remaining ?? 0,
        bulkSmsRemaining: row?.bulk_sms_remaining ?? 0,
        otpExpiresAt: row?.otp_expires_at ?? null,
        bulkExpiresAt: row?.bulk_expires_at ?? null,
        lastTransactionId: row?.last_transaction_id ?? null,
        purchasedAt: row?.purchased_at ?? null,
      },
    });
  });

  /**
   * STAGE F9 (ISSUE-88): wallet purchase history — the "wallet view shows
   * all" panel requirement. User-attributed transactions only (wallet buys
   * are not company-scoped; per-company usage history stays on the app-plane
   * /v5/billing/transactions route).
   */
  app.get("/v5/auth/wallet/transactions", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const rows = app.db
      .prepare(
        // ISSUE-89: the price unit rides the row so the wallet history never
        // renders a USD purchase with the taka symbol.
        "SELECT ct.id, ct.package_code, ct.sms_quota, ct.amount_bdt, ct.package_type, ct.status, " +
          "ct.trx_id, ct.requested_at, ct.resolved_at, COALESCE(p.currency, 'BDT') AS currency " +
          "FROM credit_transactions ct LEFT JOIN packages p ON p.id = ct.package_id " +
          "WHERE ct.user_id = ? ORDER BY ct.requested_at DESC LIMIT 100",
      )
      .all(session.user.id) as Array<{
      id: string;
      package_code: string;
      sms_quota: number;
      amount_bdt: number;
      package_type: string;
      status: string;
      trx_id: string | null;
      requested_at: number;
      resolved_at: number | null;
      currency: string;
    }>;
    return reply.code(200).send({
      ok: true,
      transactions: rows.map((t) => ({
        transactionId: t.id,
        packageCode: t.package_code,
        smsQuota: t.sms_quota,
        amountBdt: t.amount_bdt,
        packageType: t.package_type,
        currency: t.currency,
        status: t.status,
        trxId: t.trx_id,
        requestedAt: t.requested_at,
        resolvedAt: t.resolved_at,
      })),
    });
  });

  /**
   * F3 (ISSUE-81): lists the signed-in customer's apps. Secrets are never
   * re-served: the projection carries no hash material, so even a hijacked
   * session cannot exfiltrate credentials that were shown exactly once. The
   * secret-less list is also what makes an owned app recoverable in a new tab:
   * the user re-proves via POST /v5/auth/apps/link.
   */
  app.get("/v5/auth/apps", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const rows = app.db
      .prepare(
        "SELECT app_id, name, revoked_at, created_at FROM apps " +
          "WHERE owner_user_id = ? ORDER BY created_at DESC, app_id",
      )
      .all(session.user.id) as Array<{
      app_id: string;
      name: string;
      revoked_at: number | null;
      created_at: number;
    }>;
    return reply.code(200).send({
      ok: true,
      apps: rows.map((r) => ({
        appId: r.app_id,
        name: r.name,
        revoked: r.revoked_at !== null,
        createdAt: r.created_at,
      })),
    });
  });

  /**
   * F3 (ISSUE-81): claims an operator-provisioned app (owner_user_id IS NULL —
   * how Haven et al. get into the dashboard) by proving possession of its
   * appId+appSecret once. Idempotent re-prove for an app the user already owns
   * (recovering credentials in a fresh tab). Unknown appId and secret mismatch
   * share ONE envelope so the endpoint cannot enumerate registered appIds.
   */
  app.post("/v5/auth/apps/link", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;

    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }

    const body = (request.body ?? {}) as LinkBody;
    const { appId, appSecret } = body;
    if (!isNonEmptyString(appId) || !isNonEmptyString(appSecret)) {
      return reply.code(400).send({
        ok: false,
        error: "appId and appSecret are required",
        code: "invalid_request",
      });
    }

    const row = app.db
      .prepare(
        "SELECT id, app_id, name, app_secret_hash, owner_user_id, revoked_at FROM apps WHERE app_id = ?",
      )
      .get(appId) as
      | {
          id: string;
          app_id: string;
          name: string;
          app_secret_hash: string;
          owner_user_id: string | null;
          revoked_at: number | null;
        }
      | undefined;

    // Constant-time comparison even when the row is missing (dummy digest).
    const matches = constantTimeEquals(app.sha256Hex(appSecret), row?.app_secret_hash ?? DUMMY_APP_DIGEST);
    if (!row || !matches) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid app credentials", code: "invalid_app_credentials" });
    }

    if (row.owner_user_id === session.user.id) {
      // Re-prove: the caller owns this app and just supplied its credentials
      // again (e.g. new browser tab — GET /v5/auth/apps never re-serves secrets).
      return reply.code(200).send({
        ok: true,
        appId: row.app_id,
        name: row.name,
        revoked: row.revoked_at !== null,
      });
    }
    if (row.owner_user_id !== null) {
      return reply
        .code(409)
        .send({ ok: false, error: "This app is linked to another account", code: "app_already_linked" });
    }
    if (row.revoked_at !== null) {
      return reply
        .code(409)
        .send({ ok: false, error: "This app is revoked and cannot be linked", code: "app_revoked" });
    }

    // Guarded claim: the IS NULL predicate makes two concurrent claims race to
    // exactly one winner (changes === 0 → the other session won).
    const result = app.db
      .prepare("UPDATE apps SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL")
      .run(session.user.id, row.id);
    if (result.changes === 0) {
      return reply
        .code(409)
        .send({ ok: false, error: "This app is linked to another account", code: "app_already_linked" });
    }

    app.log.info({ appId: row.app_id, userId: session.user.id }, "operator-provisioned app linked by owner");
    return reply.code(200).send({ ok: true, appId: row.app_id, name: row.name, revoked: false });
  });

  /**
   * Creates a single-use hashed email token (verify/reset). The raw value is
   * returned exactly once — it exists only in the emailed link.
   */
  function createEmailToken(userId: string, purpose: "verify" | "reset", ttlSec: number): string {
    const raw = generateEmailToken();
    app.db
      .prepare(
        "INSERT INTO user_email_tokens (id, user_id, purpose, token_hash, expires_at, created_at) " +
          "VALUES (?, ?, ?, ?, unixepoch() + ?, unixepoch())",
      )
      .run(newId(), userId, purpose, hashEmailToken(raw), ttlSec);
    return raw;
  }

  /**
   * F3 amendment (ISSUE-82): public mail-capability status so the customer
   * screens can show the amendment's "clear status when SMTP isn't
   * configured" (flagged invented surface — discloses only whether email is
   * set up on this deployment, nothing account-specific).
   */
  app.get("/v5/auth/mail-status", async (_request, reply) => {
    return reply.code(200).send({ ok: true, configured: isMailConfigured(app.db) });
  });

  /**
   * F3 amendment: consumes an emailed verification token. Soft verification —
   * it never gates login; it only records the timestamp for the dashboard.
   */
  app.post("/v5/auth/verify-email", async (request, reply) => {
    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }
    const body = (request.body ?? {}) as { token?: unknown };
    if (!isNonEmptyString(body.token)) {
      return reply.code(400).send({ ok: false, error: "token is required", code: "invalid_request" });
    }
    const row = app.db
      .prepare(
        "SELECT t.id AS token_id, t.user_id, t.expires_at, t.used_at, u.email_verified_at " +
          "FROM user_email_tokens t JOIN users u ON u.id = t.user_id " +
          "WHERE t.token_hash = ? AND t.purpose = 'verify'",
      )
      .get(hashEmailToken(body.token)) as
      | { token_id: string; user_id: string; expires_at: number; used_at: number | null; email_verified_at: number | null }
      | undefined;
    if (!row || (row.used_at === null && row.expires_at <= nowSec())) {
      return reply.code(400).send({ ok: false, error: "Invalid or expired token", code: "invalid_token" });
    }
    if (row.email_verified_at === null) {
      app.db.prepare("UPDATE users SET email_verified_at = unixepoch() WHERE id = ?").run(row.user_id);
    }
    if (row.used_at === null) {
      app.db.prepare("UPDATE user_email_tokens SET used_at = unixepoch() WHERE id = ?").run(row.token_id);
    }
    return reply.code(200).send({ ok: true });
  });

  /** Session-required resend (idempotent: an already-verified account just gets ok. */
  app.post("/v5/auth/verify-email/resend", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }
    try {
      const user = app.db
        .prepare("SELECT email, email_verified_at FROM users WHERE id = ?")
        .get(session.user.id) as { email: string; email_verified_at: number | null } | undefined;
      if (user && user.email_verified_at === null && isMailConfigured(app.db) && app.config.dashboardBaseUrl !== "") {
        const raw = createEmailToken(session.user.id, "verify", app.config.emailVerifyTtlSec);
        void sendMail(
          app.db,
          app.config.jwtSecret,
          user.email,
          "Confirm your dP Relay email",
          verificationEmailBody(app.config.dashboardBaseUrl, raw),
        ).catch((err: unknown) => app.log.warn({ err }, "verification email dispatch failed"));
      }
    } catch (err) {
      app.log.warn({ err }, "verification email scheduling failed");
    }
    return reply.code(200).send({ ok: true });
  });

  /**
   * F3 amendment: self-service password reset, step 1. ALWAYS the generic
   * ok — an unknown email must be indistinguishable from an unsendable one
   * (anti-enumeration). The email only goes out when SMTP is configured.
   */
  app.post("/v5/auth/password/forgot", async (request, reply) => {
    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }
    const body = (request.body ?? {}) as { email?: unknown };
    if (isNonEmptyString(body.email)) {
      const normalized = body.email.trim().toLowerCase();
      const user = app.db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(normalized) as { id: string } | undefined;
      if (user && isMailConfigured(app.db) && app.config.dashboardBaseUrl !== "") {
        try {
          // Supersede any outstanding reset token (only the newest link works).
          app.db
            .prepare(
              "UPDATE user_email_tokens SET used_at = unixepoch() " +
                "WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL",
            )
            .run(user.id);
          const raw = createEmailToken(user.id, "reset", app.config.emailResetTtlSec);
          void sendMail(
            app.db,
            app.config.jwtSecret,
            normalized,
            "Reset your dP Relay password",
            resetEmailBody(app.config.dashboardBaseUrl, raw),
          ).catch((err: unknown) => app.log.warn({ err }, "reset email dispatch failed"));
        } catch (err) {
          app.log.warn({ err }, "reset email scheduling failed");
        }
      }
    }
    return reply.code(200).send({ ok: true });
  });

  /**
   * F3 amendment: self-service password reset, step 2. On success the new
   * hash is scrypt, the token is single-use, and EVERY session row for the
   * account is revoked (a stolen cookie dies with the old password).
   */
  app.post("/v5/auth/password/reset", async (request, reply) => {
    const verdict = authRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many auth attempts", code: "rate_limited" });
    }
    const body = (request.body ?? {}) as { token?: unknown; password?: unknown };
    if (!isNonEmptyString(body.token)) {
      return reply.code(400).send({ ok: false, error: "token is required", code: "invalid_request" });
    }
    if (!isNonEmptyString(body.password) || body.password.length < PASSWORD_MIN || body.password.length > PASSWORD_MAX) {
      return reply.code(400).send({
        ok: false,
        error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
        code: "invalid_password",
      });
    }
    const row = app.db
      .prepare(
        "SELECT id AS token_id, user_id, expires_at, used_at FROM user_email_tokens " +
          "WHERE token_hash = ? AND purpose = 'reset'",
      )
      .get(hashEmailToken(body.token)) as
      | { token_id: string; user_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.used_at !== null || row.expires_at <= nowSec()) {
      return reply.code(400).send({ ok: false, error: "Invalid or expired token", code: "invalid_token" });
    }
    const newHash = await hashPasswordScrypt(body.password);
    app.db.transaction(() => {
      app.db.prepare("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, unixepoch()) WHERE id = ?").run(newHash, row.user_id);
      app.db.prepare("UPDATE user_email_tokens SET used_at = unixepoch() WHERE id = ?").run(row.token_id);
      // Reset implies mailbox control — treat it as proof and clear ALL sessions.
      app.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(row.user_id);
    })();
    app.log.info({ userId: row.user_id }, "password reset completed");
    return reply.code(200).send({ ok: true });
  });
};

export default authRoutes;
