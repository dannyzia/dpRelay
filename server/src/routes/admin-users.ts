/**
 * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 prescriptive spec, hub event 1266) —
 * customer/user withhold plane. Operator routes to list F3 users and toggle
 * `users.disabled`, the withhold switch.
 *
 * Semantics (hub events 1213 + 1266):
 * - disable REQUIRES {reason} (spec): stored on the row (badge + reason
 *   tooltip in the panel) and written to the audit trail with operator +
 *   timestamp. All of the user's dashboard sessions are revoked EAGERLY in
 *   the same transaction — not left to the lazy rejection at resolution.
 * - login still rejects disabled rows generically (anti-enumeration) and
 *   requireApp still answers 403 account_withheld for the owner's apps;
 *   credits/balances are NEVER touched — withhold freezes, it does not
 *   confiscate.
 * - enable reverses it: clears reason + timestamp, writes the audit row.
 *   Operator-provisioned apps (owner NULL) are unaffected throughout; per-app
 *   withhold remains the existing revoke/unrevoke routes.
 */
import type { FastifyPluginAsync } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { newId } from "../services/crypto.js";

const adminUserRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Audit-trail write for one withhold action (spec: "every action writes to
   * the audit trail with operator + timestamp"). Called inside the toggle's
   * transaction so the audit row and the state change commit together.
   */
  function audit(action: "user.withhold" | "user.lift", userId: string, reason: string | null): void {
    db.prepare(
      "INSERT INTO admin_audit (id, actor, action, subject_type, subject_id, reason, created_at) " +
        "VALUES (?, 'operator', ?, 'user', ?, ?, unixepoch())",
    ).run(newId(), action, userId, reason);
  }

  /**
   * Operator user directory: every user with withhold state (including the
   * stored reason for the row tooltip) and the apps they own.
   */
  app.get("/v5/admin/users", { preHandler: [app.requireOperator] }, async () => {
    const users = db
      .prepare(
        "SELECT u.id, u.email, u.disabled, u.disabled_reason, u.disabled_at, u.created_at, " +
          "(SELECT COUNT(*) FROM apps a WHERE a.owner_user_id = u.id) AS app_count " +
          "FROM users u ORDER BY u.created_at DESC, u.id ASC",
      )
      .all() as {
      id: string;
      email: string;
      disabled: number;
      disabled_reason: string | null;
      disabled_at: number | null;
      created_at: number;
      app_count: number;
    }[];
    const owned = db
      .prepare(
        "SELECT id, owner_user_id, app_id, name, revoked_at FROM apps " +
          "WHERE owner_user_id IS NOT NULL ORDER BY created_at ASC, id ASC",
      )
      .all() as {
      id: string;
      owner_user_id: string;
      app_id: string;
      name: string;
      revoked_at: number | null;
    }[];
    const byOwner = new Map<string, { id: string; appId: string; name: string; revoked: boolean }[]>();
    for (const a of owned) {
      const list = byOwner.get(a.owner_user_id) ?? [];
      list.push({ id: a.id, appId: a.app_id, name: a.name, revoked: a.revoked_at !== null });
      byOwner.set(a.owner_user_id, list);
    }
    return {
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        disabled: u.disabled === 1,
        disabledReason: u.disabled_reason,
        disabledAt: u.disabled_at,
        createdAt: u.created_at,
        appCount: u.app_count,
        apps: byOwner.get(u.id) ?? [],
      })),
    };
  });

  /**
   * Withhold a user (disable). Reason required (spec); sessions revoked
   * immediately in the same transaction; audit row written. Idempotent;
   * balances untouched.
   */
  app.post("/v5/admin/users/:id/disable", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const userId = asString(params.id, 64);
    const body = asRecord(request.body) ?? {};
    const reason = asString(body.reason, 512);
    if (userId === null) {
      return reply.code(400).send({ ok: false, error: "user id is required", code: "invalid_user_id" });
    }
    if (reason === null || reason.trim() === "") {
      return reply.code(400).send({ ok: false, error: "reason is required", code: "reason_required" });
    }
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!exists) {
      return reply.code(404).send({ ok: false, error: "User not found", code: "user_not_found" });
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE users SET disabled = 1, disabled_reason = ?, disabled_at = unixepoch() WHERE id = ?",
      ).run(reason.trim(), userId);
      // Eager revocation (spec): the row deletion IS the logout — waiting for
      // expiry/next resolution would leave a withheld user's cookie valid.
      db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      audit("user.withhold", userId, reason.trim());
    })();
    app.log.info({ userId }, "user withheld (disabled)");
    return { ok: true, userId, disabled: true, reason: reason.trim() };
  });

  /** Lift the withhold (enable): clears reason + timestamp, audits. Idempotent. */
  app.post("/v5/admin/users/:id/enable", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const userId = asString(params.id, 64);
    if (userId === null) {
      return reply.code(400).send({ ok: false, error: "user id is required", code: "invalid_user_id" });
    }
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!exists) {
      return reply.code(404).send({ ok: false, error: "User not found", code: "user_not_found" });
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE users SET disabled = 0, disabled_reason = NULL, disabled_at = NULL WHERE id = ?",
      ).run(userId);
      audit("user.lift", userId, null);
    })();
    app.log.info({ userId }, "user un-withheld (enabled)");
    return { ok: true, userId, disabled: false };
  });
};

export default adminUserRoutes;
