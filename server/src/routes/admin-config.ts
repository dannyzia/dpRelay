/**
 * STAGE F5b (ISSUE-84, prescriptive spec hub event 1266) — operator config
 * plane. A tiny key-value store (migration 014, `admin_config`) behind a
 * hard whitelist: ONLY the two payment-match keys exist, so `:key` can never
 * become a generic read/write primitive over arbitrary server state.
 *
 * Both keys are integer-valued; per-key bounds keep a typo from pinning the
 * proposal engine to a meaningless value. Read helpers are exported so the
 * matching code (routes/admin-payments.ts) consumes the SAME whitelist and
 * defaults — one source of truth, no drift.
 */
import type { FastifyPluginAsync, FastifyInstance } from "fastify";

/** better-sqlite3 handle as exposed on the fastify instance. */
type Db = FastifyInstance["db"];

interface ConfigRule {
  /** Human name used in error messages. */
  label: string;
  min: number;
  max: number;
  /** Fallback when the row is missing (mirrors migration 014 seeds). */
  fallback: number;
}

/**
 * The whitelist. Adding a key here is the ONLY way to extend the config
 * surface — the routes reject anything absent from this map with 404.
 */
export const ADMIN_CONFIG_KEYS: Record<string, ConfigRule> = {
  payment_match_window_min: {
    label: "payment match window (minutes)",
    min: 0,
    max: 525600, // 365 days in minutes
    fallback: 30,
  },
  payment_match_tolerance_bdt: {
    label: "payment match amount tolerance (BDT)",
    min: 0,
    max: 1_000_000,
    fallback: 0,
  },
};

/**
 * Reads one whitelisted key's value at request time (rows are mutable — the
 * operator tunes them from #/operator → Settings and matching must see the
 * new value on the next request).
 *
 * @param db database handle
 * @param key whitelisted config key
 * @returns the stored integer, or the key's fallback when the row is absent
 */
export function readConfigValue(db: Db, key: string): number {
  const rule = ADMIN_CONFIG_KEYS[key];
  if (rule === undefined) return 0;
  const row = db.prepare("SELECT value FROM admin_config WHERE key = ?").get(key) as
    | { value: number }
    | undefined;
  return row?.value ?? rule.fallback;
}

const adminConfigRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  app.get("/v5/admin/config/:key", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const key = String((request.params as { key?: unknown }).key ?? "");
    const rule = ADMIN_CONFIG_KEYS[key];
    if (rule === undefined) {
      return reply.code(404).send({ ok: false, error: "Unknown config key", code: "unknown_config_key" });
    }
    const row = db.prepare("SELECT value, updated_at FROM admin_config WHERE key = ?").get(key) as
      | { value: number; updated_at: number }
      | undefined;
    return { ok: true, key, value: row?.value ?? rule.fallback, updatedAt: row?.updated_at ?? null };
  });

  app.put("/v5/admin/config/:key", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const key = String((request.params as { key?: unknown }).key ?? "");
    const rule = ADMIN_CONFIG_KEYS[key];
    if (rule === undefined) {
      return reply.code(404).send({ ok: false, error: "Unknown config key", code: "unknown_config_key" });
    }
    const body = (request.body ?? {}) as { value?: unknown };
    const value = body.value;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < rule.min ||
      value > rule.max
    ) {
      return reply.code(400).send({
        ok: false,
        error: `${rule.label} must be an integer between ${rule.min} and ${rule.max}`,
        code: "invalid_config_value",
      });
    }
    db.prepare(
      "INSERT INTO admin_config (key, value, updated_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value);
    const row = db.prepare("SELECT updated_at FROM admin_config WHERE key = ?").get(key) as {
      updated_at: number;
    };
    app.log.info({ key, value }, "admin config updated");
    return { ok: true, key, value, updatedAt: row.updated_at };
  });
};

export default adminConfigRoutes;
