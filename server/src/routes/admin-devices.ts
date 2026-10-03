/**
 * Operator device lifecycle (ISSUE-38).
 *
 * The watchdog could flag a device as stale forever with no way to answer the
 * only two questions that matter: which devices are these, and can I stop them
 * alerting? `revocable` and `revoked_at` have existed on the devices table since
 * migration 003, but nothing ever wrote `revoked_at` for a device and no route
 * returned per-device staleness — so the only available answer was direct DB
 * access on production.
 *
 * Both routes are gated by requireOperator (OPERATOR_SECRET), the same guard as
 * the admin app and billing routes.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { findStaleDevices } from "../jobs.js";
import { asRecord, asString } from "../services/parse.js";

function fail(reply: FastifyReply, code: number, codeName: string, message: string): FastifyReply {
  return reply.code(code).send({ ok: false, error: message, code: codeName });
}

interface DeviceRow {
  id: string;
  user_id: string | null;
  label: string;
  last_seen_at: number | null;
  created_at: number;
  revocable: number;
  revoked_at: number | null;
}

const adminDeviceRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Lists devices with their staleness resolved server-side, so the operator
   * does not have to reimplement the watchdog's age rule (and its
   * never-seen-grace rule) to decide what to act on.
   */
  app.get("/v5/admin/devices", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.query) ?? {};
    const staleOnly = params.stale === "true";
    const includeRevoked = params.includeRevoked === "true";
    const limit = Math.min(Math.max(Number(asString(params.limit, 4) ?? "200") || 200, 1), 500);

    const nowSec = Math.floor(Date.now() / 1000);

    // Staleness is taken from the watchdog's own query rather than reimplemented
    // here: the list and the alerting path must never be able to disagree about
    // which devices are stale (never-seen devices are aged against created_at).
    const staleIds = new Set(
      findStaleDevices(db, app.config.watchdogStaleSec).map((d) => d.id),
    );

    const rows = db
      .prepare(
        "SELECT id, user_id, label, last_seen_at, created_at, revocable, revoked_at FROM devices " +
          "WHERE (? = 1 OR revoked_at IS NULL) ORDER BY last_seen_at IS NOT NULL, last_seen_at ASC LIMIT ?",
      )
      .all(includeRevoked ? 1 : 0, limit) as DeviceRow[];

    const devices = rows.map((r) => ({
      id: r.id,
      label: r.label,
      userId: r.user_id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      /** null = never heartbeaten; age is then measured from createdAt. */
      secondsSinceSeen: nowSec - (r.last_seen_at ?? r.created_at),
      neverSeen: r.last_seen_at === null,
      stale: staleIds.has(r.id),
      revocable: r.revocable === 1,
      revokedAt: r.revoked_at,
    }));

    return {
      ok: true,
      staleThresholdSec: app.config.watchdogStaleSec,
      alertRepeatSec: app.config.watchdogAlertRepeatSec,
      total: devices.length,
      staleCount: devices.filter((d) => d.stale).length,
      neverSeenCount: devices.filter((d) => d.neverSeen).length,
      devices: staleOnly ? devices.filter((d) => d.stale) : devices,
    };
  });

  /**
   * Revokes a device so the watchdog stops flagging it. This is the operator
   * lever ISSUE-38 lacked: the alternative to revoking a decommissioned phone
   * was leaving it alerting every tick forever.
   *
   * Idempotent, and refuses devices marked revocable = 0 — those are permanent
   * by design and must be revoked by a deliberate data decision, not an API call.
   */
  app.post("/v5/admin/devices/:id/revoke", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const deviceId = asString(params.id, 64);
    if (deviceId === null) return fail(reply, 400, "invalid_device_id", "Device id is required");

    const row = db
      .prepare("SELECT id, revocable, revoked_at FROM devices WHERE id = ?")
      .get(deviceId) as { id: string; revocable: number; revoked_at: number | null } | undefined;
    if (!row) return fail(reply, 404, "device_not_found", "Device not found");

    if (row.revocable !== 1) {
      return fail(
        reply,
        409,
        "device_not_revocable",
        "Device is marked non-revocable and cannot be revoked through this route",
      );
    }
    if (row.revoked_at !== null) {
      // Idempotent: re-revoking reports current state instead of erroring, so a
      // retried operator script does not need to read first.
      return { ok: true, deviceId: row.id, revoked: true, revokedAt: row.revoked_at, alreadyRevoked: true };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(nowSec, deviceId);
    app.log.warn({ deviceId }, "device revoked by operator");
    return { ok: true, deviceId: row.id, revoked: true, revokedAt: nowSec, alreadyRevoked: false };
  });
};

export default adminDeviceRoutes;
