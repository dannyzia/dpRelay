/**
 * Admin app-plane routes (M4 pass 3 remainder, PLAN §10). Operator-gated
 * management of the 004 apps registry: register (with optional server-side
 * secret generation), list, revoke/unrevoke, rotate the webhook secret, and
 * update the webhook URL. Also exposes the global SMS kill switch
 * (settings.kill_switch) so the pause lever behind OTP sends is reachable
 * without DB access.
 *
 * Auth model (single choke point per plan §5): every route gates via
 * requireOperator (OPERATOR_SECRET) — the same guard as admin billing. These
 * routes never authenticate AS an app; they manage apps.
 *
 * Revocation semantics: requireApp already rejects any app with a non-null
 * revoked_at (401 app_revoked), so revoking here cuts off every app-plane
 * route instantly — OTP send/verify, billing, campaigns, groups, templates.
 *
 * Secret handling: appSecret and webhook_secret are return-once at mint/
 * rotation; only SHA-256 hashes are stored. Listing never exposes secrets.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { generateWebhookSecret, newId, sha256Hex } from "../services/crypto.js";

/** List pagination cap (campaigns parity). */
const LIST_MAX = 100;
const LIST_DEFAULT = 50;

/** Rejects with the structured envelope. */
function fail(reply: FastifyReply, code: number, codeName: string, message: string): FastifyReply {
  return reply.code(code).send({ ok: false, error: message, code: codeName });
}

interface AdminAppRow {
  id: string;
  app_id: string;
  name: string;
  webhook_url: string | null;
  rate_max_per_phone: number;
  rate_window_sec: number;
  created_at: number;
  revoked_at: number | null;
}

function publicApp(row: AdminAppRow) {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    webhookUrl: row.webhook_url,
    rateMaxPerPhone: row.rate_max_per_phone,
    rateWindowSec: row.rate_window_sec,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** Validates and normalizes a webhook URL (HTTPS-only, register parity). */
function parseWebhookUrl(reply: FastifyReply, raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    fail(reply, 400, "invalid_webhook_url", "webhookUrl must be a string");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(reply, 400, "invalid_webhook_url", "webhookUrl must be an absolute https:// URL");
    return null;
  }
  if (parsed.protocol !== "https:") {
    fail(reply, 400, "invalid_webhook_url", "webhookUrl must be an absolute https:// URL");
    return null;
  }
  return parsed.toString();
}

const adminAppRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Registers an app (operator variant of POST /v5/apps/register). appSecret
   * may be omitted — the server then generates one (min-length policy holds
   * for caller-supplied secrets either way). The response is the ONLY place
   * the appSecret and webhook_secret are ever returned.
   */
  app.post("/v5/admin/apps", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const appId = asString(body.appId, 64);
    if (appId === null || !/^[A-Za-z0-9_-]{3,64}$/.test(appId)) {
      return fail(reply, 400, "invalid_app_id", "appId must be 3-64 chars of [A-Za-z0-9_-]");
    }
    let appSecret = asString(body.appSecret, 4096);
    if (body.appSecret !== undefined && body.appSecret !== null && typeof body.appSecret !== "string") {
      return fail(reply, 400, "invalid_app_secret", "appSecret must be a string");
    }
    if (appSecret !== null && appSecret.length < 32) {
      return fail(reply, 400, "invalid_app_secret", "appSecret must be at least 32 chars");
    }
    const generated = appSecret === null;
    if (appSecret === null) appSecret = generateWebhookSecret();

    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim().slice(0, 128)
        : appId;
    const webhookUrl = parseWebhookUrl(reply, body.webhookUrl);
    if (webhookUrl === null) return;

    const rateMaxPerPhone =
      typeof body.rateMaxPerPhone === "number" && Number.isInteger(body.rateMaxPerPhone)
        ? body.rateMaxPerPhone
        : 3;
    const rateWindowSec =
      typeof body.rateWindowSec === "number" && Number.isInteger(body.rateWindowSec)
        ? body.rateWindowSec
        : 3600;
    if (rateMaxPerPhone < 1 || rateWindowSec < 1) {
      return fail(reply, 400, "invalid_rate_limits", "rateMaxPerPhone and rateWindowSec must be >= 1");
    }

    const rowId = newId();
    const webhookSecret = generateWebhookSecret();
    try {
      db.prepare(
        "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, " +
          "webhook_secret_hash, rate_max_per_phone, rate_window_sec, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())",
      ).run(rowId, appId, sha256Hex(appSecret), name, webhookUrl, webhookSecret, sha256Hex(webhookSecret), rateMaxPerPhone, rateWindowSec);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: apps.app_id")) {
        return fail(reply, 409, "app_id_exists", "appId already registered");
      }
      throw err;
    }
    app.log.info({ appId }, "app registered via admin plane");
    const response: Record<string, unknown> = {
      ok: true,
      id: rowId,
      appId,
      name,
      webhookUrl,
      webhookSecret,
      appSecretGenerated: generated,
      // Return-once contract: the operator needs the effective secret either
      // way (a generated one exists nowhere else).
      appSecret,
    };
    return reply.code(201).send(response);
  });

  /** Lists all apps (never secrets), newest first, keyset-paginated. */
  app.get("/v5/admin/apps", { preHandler: [app.requireOperator] }, async (request) => {
    const query = asRecord(request.query) ?? {};
    const limitRaw = query.limit;
    const limitNum =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Number.parseInt(limitRaw, 10)
          : NaN;
    const limit = Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, LIST_MAX) : LIST_DEFAULT;
    const cursorRaw = query.cursor;
    let cursorAt: number | null = null;
    let cursorId: string | null = null;
    if (typeof cursorRaw === "string") {
      const sep = cursorRaw.indexOf(":");
      const at = sep > 0 ? Number.parseInt(cursorRaw.slice(0, sep), 10) : NaN;
      const id = sep > 0 ? cursorRaw.slice(sep + 1) : "";
      if (Number.isInteger(at) && at >= 0 && id.length > 0) {
        cursorAt = at;
        cursorId = id;
      }
    }

    const rows = db
      .prepare(
        "SELECT id, app_id, name, webhook_url, rate_max_per_phone, rate_window_sec, created_at, revoked_at " +
          "FROM apps WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id > ?)) " +
          "ORDER BY created_at DESC, id ASC LIMIT ?",
      )
      .all(cursorAt, cursorAt, cursorAt, cursorId, limit + 1) as AdminAppRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      apps: page.map(publicApp),
      nextCursor: hasMore
        ? `${page[page.length - 1]?.created_at ?? 0}:${page[page.length - 1]?.id ?? ""}`
        : null,
    };
  });

  /** Loads one app by internal id, or null (404 at call site). */
  function loadApp(appRowId: string): AdminAppRow | null {
    return (
      (db
        .prepare(
          "SELECT id, app_id, name, webhook_url, rate_max_per_phone, rate_window_sec, created_at, revoked_at " +
            "FROM apps WHERE id = ?",
        )
        .get(appRowId) as AdminAppRow | undefined) ?? null
    );
  }

  /**
   * Revokes an app: requireApp rejects every subsequent app-plane request
   * with 401 app_revoked. Campaign/recipient rows are untouched — v5 refunds
   * via the cancel route, not revocation.
   */
  app.post("/v5/admin/apps/:id/revoke", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const appRowId = asString(params.id, 64);
    if (appRowId === null) return fail(reply, 400, "invalid_app_id", "app id is required");
    const row = loadApp(appRowId);
    if (!row) return fail(reply, 404, "admin_app_not_found", "App not found");
    if (row.revoked_at !== null) {
      return fail(reply, 409, "already_revoked", "App is already revoked");
    }
    db.prepare("UPDATE apps SET revoked_at = unixepoch() WHERE id = ?").run(appRowId);
    app.log.info({ appId: row.app_id }, "app revoked via admin plane");
    return { ok: true, appId: row.app_id, revokedAt: Math.floor(Date.now() / 1000) };
  });

  /** Un-revokes an app (restores app-plane access immediately). */
  app.post("/v5/admin/apps/:id/unrevoke", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const appRowId = asString(params.id, 64);
    if (appRowId === null) return fail(reply, 400, "invalid_app_id", "app id is required");
    const row = loadApp(appRowId);
    if (!row) return fail(reply, 404, "admin_app_not_found", "App not found");
    if (row.revoked_at === null) {
      return fail(reply, 409, "not_revoked", "App is not revoked");
    }
    db.prepare("UPDATE apps SET revoked_at = NULL WHERE id = ?").run(appRowId);
    app.log.info({ appId: row.app_id }, "app un-revoked via admin plane");
    return { ok: true, appId: row.app_id };
  });

  /**
   * Rotates the webhook secret: mints a new one (returned ONCE here), stores
   * the hash, and stamps webhook_rotated_at. The old secret stops verifying
   * immediately; in-flight dispatch retries signed with it will fail — the
   * audit rows keep their record.
   */
  app.post("/v5/admin/apps/:id/rotate-webhook-secret", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const appRowId = asString(params.id, 64);
    if (appRowId === null) return fail(reply, 400, "invalid_app_id", "app id is required");
    const row = loadApp(appRowId);
    if (!row) return fail(reply, 404, "admin_app_not_found", "App not found");

    const webhookSecret = generateWebhookSecret();
    db.prepare(
      "UPDATE apps SET webhook_secret = ?, webhook_secret_hash = ?, webhook_rotated_at = unixepoch() WHERE id = ?",
    ).run(webhookSecret, sha256Hex(webhookSecret), appRowId);
    app.log.info({ appId: row.app_id }, "webhook secret rotated via admin plane");
    return { ok: true, appId: row.app_id, webhookSecret, rotatedAt: Math.floor(Date.now() / 1000) };
  });

  /** Updates the webhook URL (HTTPS-only; empty string clears it). */
  app.patch("/v5/admin/apps/:id/webhook", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const appRowId = asString(params.id, 64);
    if (appRowId === null) return fail(reply, 400, "invalid_app_id", "app id is required");
    const row = loadApp(appRowId);
    if (!row) return fail(reply, 404, "admin_app_not_found", "App not found");

    const body = asRecord(request.body) ?? {};
    if (body.webhookUrl === undefined) {
      return fail(reply, 400, "invalid_webhook_url", "webhookUrl is required (empty string clears it)");
    }
    if (body.webhookUrl === "" || body.webhookUrl === null) {
      db.prepare("UPDATE apps SET webhook_url = NULL WHERE id = ?").run(appRowId);
      return { ok: true, appId: row.app_id, webhookUrl: null };
    }
    const webhookUrl = parseWebhookUrl(reply, body.webhookUrl);
    if (webhookUrl === null || webhookUrl === undefined) return;
    db.prepare("UPDATE apps SET webhook_url = ? WHERE id = ?").run(webhookUrl, appRowId);
    return { ok: true, appId: row.app_id, webhookUrl };
  });

  /**
   * Global SMS kill switch (settings.kill_switch, seeded by migration 001):
   * the pause lever behind POST /v5/otp/send — when on, sends reject with
   * 503 sms_paused while verification of already-delivered codes keeps
   * working (routes/otp.ts). `enabled: true` pauses, `false` resumes; the
   * response reports the PREVIOUS state so the caller knows what the flip
   * changed, and no-op flips to the current state never touch the row.
   */
  app.post("/v5/admin/kill-switch", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    if (typeof body.enabled !== "boolean") {
      return fail(reply, 400, "invalid_enabled", "enabled must be a boolean (true pauses SMS, false resumes)");
    }
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'kill_switch'")
      .get() as { value: string } | undefined;
    if (!row) {
      // 001 seeds this row; a missing row means a foreign/pre-migration DB.
      return fail(reply, 500, "kill_switch_missing", "kill_switch setting is not initialized");
    }
    const previous = row.value === "true";
    if (previous === body.enabled) {
      return { ok: true, previous, enabled: body.enabled, changed: false };
    }
    db
      .prepare("UPDATE settings SET value = ?, updated_at = unixepoch() WHERE key = 'kill_switch'")
      .run(body.enabled ? "true" : "false");
    app.log.info({ previous, enabled: body.enabled }, "SMS kill switch toggled via admin plane");
    return { ok: true, previous, enabled: body.enabled, changed: true };
  });
};

export default adminAppRoutes;
