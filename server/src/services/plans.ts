/**
 * Unlimited BYOD plan core (ISSUE-96).
 *
 * A plan covers gateway orchestration for the customer-owned Android phones
 * BOUND to the app (devices.app_id, F7) — never the dedicated BD operator
 * pool. Every credit-bypass decision in routes/otp.ts and services/bulk.ts
 * funnels through `byodEligible` so there is exactly ONE definition of "this
 * send rides the customer's own phone for free":
 *
 *   1. the app has an ACTIVE subscription (status='active' AND expires_at in
 *      the future — an expired plan fails closed to normal credit charging);
 *   2. the app has at least one live (non-revoked) BOUND device — without one,
 *      the message would fall to the BD operator fleet, which must always be
 *      paid for (route separation, anti-spoofing).
 *
 * The subscription decision is always read fresh from SQLite inside the same
 * transaction that spends money — never cached on the request — so a plan
 * expiring mid-flight fails closed on the very next send.
 */
import type { FastifyInstance } from "fastify";

/** better-sqlite3 handle as exposed on the fastify instance. */
type Db = FastifyInstance["db"];

/** One purchasable tier. Prices are whole USD per 30-day period. */
export interface PlanTier {
  code: "unlimited_1" | "unlimited_5" | "unlimited_20";
  name: string;
  maxDevices: number;
  priceUsd: number;
  validityDays: number;
}

/**
 * The plan catalog (owner pricing decision, ISSUE-96). A plain constant, not
 * env config: the tiers are product definition, identical across every
 * deployment, and the API response and the purchase route must agree exactly.
 */
export const PLAN_TIERS: readonly PlanTier[] = [
  { code: "unlimited_1", name: "Unlimited BYOD 1 phone", maxDevices: 1, priceUsd: 16, validityDays: 30 },
  { code: "unlimited_5", name: "Unlimited BYOD 5 phones", maxDevices: 5, priceUsd: 49, validityDays: 30 },
  { code: "unlimited_20", name: "Unlimited BYOD 20 phones", maxDevices: 20, priceUsd: 129, validityDays: 30 },
];

/** Looks a tier up by its public code, or null when unknown. */
export function planTier(code: string): PlanTier | null {
  return PLAN_TIERS.find((t) => t.code === code) ?? null;
}

/** Row shape of an ACTIVE (status-wise) subscription — expires_at may still be past. */
export interface SubscriptionRow {
  id: string;
  app_id: string;
  plan_code: string;
  max_devices: number;
  price_usd: number;
  status: string;
  expires_at: number | null;
}

/**
 * The app's active subscription, regardless of clock expiry. Callers that
 * gate sends must ALSO check expires_at (see byodEligible); slot enforcement
 * uses this directly — a lapsed plan keeps its device slots occupied, it does
 * not silently unlock unlimited enrollment.
 *
 * @param db database handle
 * @param appRowId internal apps.id
 */
export function activeSubscription(db: Db, appRowId: string): SubscriptionRow | null {
  const row = db
    .prepare(
      "SELECT id, app_id, plan_code, max_devices, price_usd, status, expires_at " +
        "FROM app_subscriptions WHERE app_id = ? AND status = 'active' LIMIT 1",
    )
    .get(appRowId) as SubscriptionRow | undefined;
  return row ?? null;
}

/**
 * Live (non-revoked) bound-device count — the slot usage of the app.
 *
 * @param db database handle
 * @param appRowId internal apps.id
 */
export function boundDeviceCount(db: Db, appRowId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE app_id = ? AND revoked_at IS NULL")
    .get(appRowId) as { n: number };
  return row.n;
}

/**
 * The single free-pass predicate (see module docblock). MUST be called inside
 * the money transaction (or immediately before an atomic check+insert) so the
 * subscription state it reads is the state that commits.
 *
 * @param db database handle
 * @param appRowId internal apps.id
 * @param nowSec current time, epoch seconds (injected for testability)
 * @returns true when this app's send may bypass credit charging
 */
export function byodEligible(db: Db, appRowId: string, nowSec: number): boolean {
  const sub = activeSubscription(db, appRowId);
  if (sub === null) return false;
  if (sub.expires_at === null || sub.expires_at <= nowSec) return false;
  return boundDeviceCount(db, appRowId) > 0;
}
