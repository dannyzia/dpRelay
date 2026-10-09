/**
 * STAGE F5 (ISSUE-83) — customer/user withhold plane. Operator routes to
 * list F3 users and toggle `users.disabled`, the withhold switch.
 *
 * Semantics (hub event 1213):
 * - disable = withhold. Login already rejects disabled rows (generic 401,
 *   anti-enumeration) and dashboard session resolution rejects them too
 *   (routes/auth.ts reads u.disabled); requireApp now rejects the owner's
 *   apps with account_withheld (sends included). Credits/balances are NEVER
 *   touched — withhold freezes, it does not confiscate.
 * - enable reverses it. Both toggles are idempotent.
 * - Operator-provisioned apps (owner NULL) are unaffected by user withhold;
 *   per-app withhold remains the existing revoke/unrevoke routes.
 */
import type { FastifyPluginAsync } from "fastify";
import { asRecord, asString } from "../services/parse.js";

const adminUserRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Operator user directory: every user with withhold state and the apps
   * they own (panel needs both to render the per-user and per-app toggles).
   */
  app.get("/v5/admin/users", { preHandler: [app.requireOperator] }, async () => {
    const users = db
      .prepare(
        "SELECT u.id, u.email, u.disabled, u.created_at, " +
          "(SELECT COUNT(*) FROM apps a WHERE a.owner_user_id = u.id) AS app_count " +
          "FROM users u ORDER BY u.created_at DESC, u.id ASC",
      )
      .all() as {
      id: string;
      email: string;
      disabled: number;
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
        createdAt: u.created_at,
        appCount: u.app_count,
        apps: byOwner.get(u.id) ?? [],
      })),
    };
  });

  /** Withhold a user (disable). Idempotent; balances untouched. */
  app.post("/v5/admin/users/:id/disable", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const userId = asString(params.id, 64);
    if (userId === null) {
      return reply.code(400).send({ ok: false, error: "user id is required", code: "invalid_user_id" });
    }
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!exists) {
      return reply.code(404).send({ ok: false, error: "User not found", code: "user_not_found" });
    }
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ? AND disabled != 1").run(userId);
    app.log.info({ userId }, "user withheld (disabled)");
    return { ok: true, userId, disabled: true };
  });

  /** Lift the withhold (enable). Idempotent. */
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
    db.prepare("UPDATE users SET disabled = 0 WHERE id = ? AND disabled != 0").run(userId);
    app.log.info({ userId }, "user un-withheld (enabled)");
    return { ok: true, userId, disabled: false };
  });
};

export default adminUserRoutes;
