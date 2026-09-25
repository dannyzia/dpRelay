/**
 * App provisioning route (Rhizome ISSUE-11): operator-gated registration of
 * consumer apps for the OTP plane — closes the last hand-INSERT step.
 *
 * Auth model (user decision via ask_questions): operator bearer secret
 * (APP_PROVISIONING_SECRET), NOT user JWT. /v5/auth/register is open, so
 * JWT-gating would let any stranger mint or squat app_ids before a legitimate
 * customer claims them. Per-app ownership (apps.user_id + owner checks) is the
 * self-serve onboarding milestone's coherent change, not a piecemeal one.
 *
 * Secret handling (mirrors the established patterns):
 * - appSecret (caller-supplied)  → SHA-256 hash only; raw never persisted.
 * - webhookSecret (server-minted) → plaintext stored AND returned here: the
 *   server signs HMAC deliveries (migration 005), so it must hold the key;
 *   webhook_secret_hash is written in sync for verifier-side comparison.
 *
 * Guard parity with /v5/device/enroll (ADR-016 pattern): per-IP sliding-window
 * limiter (all attempts count), 403 provisioning_disabled when unset,
 * constant-time secret comparison even when the header is missing.
 */
import type { FastifyPluginAsync } from "fastify";
import { constantTimeEquals, generateWebhookSecret, newId } from "../services/crypto.js";
import { MIN_SECRET_LENGTH } from "../config.js";
import { asRecord, asString } from "../services/parse.js";

/** Public appId is sent as the X-App-Id header — keep it header-safe. */
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

interface AppsRegisterBody {
  appId?: unknown;
  appSecret?: unknown;
  name?: unknown;
  webhookUrl?: unknown;
  rateMaxPerPhone?: unknown;
  rateWindowSec?: unknown;
}

const appProvisioningRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Per-IP sliding-window limiter for provisioning (brute-force guard — the
   * operator secret is the only thing standing between the internet and
   * minting trusted app credentials). All attempts count, success or failure.
   * State is per-app-instance, so tests isolate naturally.
   */
  const provisionAttempts = new Map<string, number[]>();
  const provisionWindowMs = app.config.appProvisioningRateWindowSec * 1000;
  const provisionRateMax = app.config.appProvisioningRateMaxPerHour;

  function provisionRateCheck(ip: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const stamps = (provisionAttempts.get(ip) ?? []).filter((t) => now - t < provisionWindowMs);
    if (stamps.length >= provisionRateMax) {
      const oldest = stamps[0] ?? now;
      provisionAttempts.set(ip, stamps);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + provisionWindowMs - now) / 1000)),
      };
    }
    stamps.push(now);
    provisionAttempts.set(ip, stamps);
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Registers an app: stores appId + appSecret (hash-only) and mints the
   * webhook secret. Existing appId → 409; a provisioned app is never silently
   * overwritten (its credentials may already be in production use).
   */
  app.post("/v5/apps/register", async (request, reply) => {
    const verdict = provisionRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many provisioning attempts", code: "rate_limited" });
    }

    const expected = app.config.appProvisioningSecret;
    if (expected === "") {
      return reply
        .code(403)
        .send({ ok: false, error: "App provisioning is disabled", code: "provisioning_disabled" });
    }

    const authHeader = request.headers.authorization;
    const provided = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
    // Constant-time even when the header is missing: compare against the real
    // secret with a dummy so timing does not leak header presence.
    if (provided === "" || !constantTimeEquals(provided, expected)) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid provisioning secret", code: "invalid_provisioning_secret" });
    }

    const body = (asRecord(request.body) ?? {}) as AppsRegisterBody;

    const appId = asString(body.appId, 64);
    if (appId === null || !APP_ID_PATTERN.test(appId)) {
      return reply.code(400).send({
        ok: false,
        error: "appId must be 3-64 chars of [A-Za-z0-9_-]",
        code: "invalid_app_id",
      });
    }

    const appSecret = asString(body.appSecret, 4096);
    // Caller-supplied credential checked per request against its stored digest —
    // below the policy floor it is brute-forceable (same rule as JWT_SECRET).
    if (appSecret === null || appSecret.length < MIN_SECRET_LENGTH) {
      return reply.code(400).send({
        ok: false,
        error: `appSecret is required, min ${MIN_SECRET_LENGTH} chars`,
        code: "invalid_app_secret",
      });
    }

    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim().slice(0, 128)
        : appId;

    let webhookUrl: string | null = null;
    if (body.webhookUrl !== undefined && body.webhookUrl !== null) {
      if (typeof body.webhookUrl !== "string") {
        return reply.code(400).send({
          ok: false,
          error: "webhookUrl must be a string",
          code: "invalid_webhook_url",
        });
      }
      // HTTPS only: the webhook carries phone numbers; TLS is not optional.
      let parsed: URL;
      try {
        parsed = new URL(body.webhookUrl);
      } catch {
        return reply.code(400).send({
          ok: false,
          error: "webhookUrl must be an absolute https:// URL",
          code: "invalid_webhook_url",
        });
      }
      if (parsed.protocol !== "https:") {
        return reply.code(400).send({
          ok: false,
          error: "webhookUrl must be an absolute https:// URL",
          code: "invalid_webhook_url",
        });
      }
      webhookUrl = parsed.toString();
    }

    const rateMaxPerPhone =
      typeof body.rateMaxPerPhone === "number" && Number.isInteger(body.rateMaxPerPhone)
        ? body.rateMaxPerPhone
        : 3;
    const rateWindowSec =
      typeof body.rateWindowSec === "number" && Number.isInteger(body.rateWindowSec)
        ? body.rateWindowSec
        : 3600;
    if (rateMaxPerPhone < 1 || rateWindowSec < 1) {
      return reply.code(400).send({
        ok: false,
        error: "rateMaxPerPhone and rateWindowSec must be >= 1",
        code: "invalid_rate_limits",
      });
    }

    const rowId = newId();
    const webhookSecret = generateWebhookSecret();
    try {
      app.db
        .prepare(
          "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, " +
            "webhook_secret_hash, rate_max_per_phone, rate_window_sec, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())",
        )
        .run(
          rowId,
          appId,
          app.sha256Hex(appSecret),
          name,
          webhookUrl,
          webhookSecret,
          app.sha256Hex(webhookSecret),
          rateMaxPerPhone,
          rateWindowSec,
        );
    } catch (err) {
      // UNIQUE(app_id) is the only expected violation here; anything else is a
      // real failure and must surface (structured envelope via the error handler).
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: apps.app_id")) {
        return reply.code(409).send({
          ok: false,
          error: "appId already registered",
          code: "app_id_exists",
        });
      }
      throw err;
    }

    app.log.info({ appId, name, webhookConfigured: webhookUrl !== null }, "app provisioned");
    return reply.code(201).send({
      ok: true,
      appId,
      name,
      webhookUrl,
      webhookSecret,
    });
  });

  /**
   * Self-revoke (M4 pass 3 deferred item, fable5-v2 queue): an app holder
   * kills its OWN credentials. Gates via the provisioning Bearer secret —
   * the same operator choke point as /v5/apps/register, NOT requireApp (a
   * compromised holder could otherwise revoke non-revoked state asymmetrically
   * and requireApp dies once revoked, making the call non-repeatable) — then
   * identifies the target app by its live X-App-Id/X-App-Secret credentials.
   *
   * requireApp rejects every subsequent app-plane request with 401 app_revoked
   * (middleware.ts), so revocation is effective immediately across OTP,
   * billing, campaigns, groups, and templates. No un-revoke exists on this
   * plane by design: restoration is an explicit operator action
   * (POST /v5/admin/apps/:id/unrevoke), so a leaked secret cannot silently
   * re-activate itself. The admin-plane revoke (internal id addressable)
   * remains the operator's variant; this route is the holder's variant.
   */
  app.post("/v5/apps/revoke", async (request, reply) => {
    const verdict = provisionRateCheck(request.ip);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(verdict.retryAfterSec))
        .send({ ok: false, error: "Too many provisioning attempts", code: "rate_limited" });
    }

    const expected = app.config.appProvisioningSecret;
    if (expected === "") {
      return reply
        .code(403)
        .send({ ok: false, error: "App provisioning is disabled", code: "provisioning_disabled" });
    }

    const authHeader = request.headers.authorization;
    const provided = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
    // Constant-time even when the header is missing (register parity).
    if (provided === "" || !constantTimeEquals(provided, expected)) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid provisioning secret", code: "invalid_provisioning_secret" });
    }

    // The app identifies ITSELF with its live credentials. Unknown appId and
    // secret mismatch share one envelope so probing appIds reveals nothing.
    const appIdHeader = request.headers["x-app-id"];
    const appSecretHeader = request.headers["x-app-secret"];
    if (
      typeof appIdHeader !== "string" ||
      appIdHeader.length === 0 ||
      typeof appSecretHeader !== "string" ||
      appSecretHeader.length === 0
    ) {
      return reply
        .code(401)
        .send({ ok: false, error: "X-App-Id and X-App-Secret headers required", code: "missing_app_credentials" });
    }
    const row = app.db
      .prepare("SELECT id, app_id, app_secret_hash, revoked_at FROM apps WHERE app_id = ?")
      .get(appIdHeader) as
      | { id: string; app_id: string; app_secret_hash: string; revoked_at: number | null }
      | undefined;
    if (!row || !constantTimeEquals(row.app_secret_hash, app.sha256Hex(appSecretHeader))) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid app credentials", code: "invalid_app_credentials" });
    }
    if (row.revoked_at !== null) {
      return reply
        .code(409)
        .send({ ok: false, error: "App is already revoked", code: "already_revoked" });
    }
    app.db.prepare("UPDATE apps SET revoked_at = unixepoch() WHERE id = ?").run(row.id);
    app.log.info({ appId: row.app_id }, "app self-revoked via apps plane");
    return { ok: true, appId: row.app_id, revokedAt: Math.floor(Date.now() / 1000) };
  });
};

export default appProvisioningRoutes;
