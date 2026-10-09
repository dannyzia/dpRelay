/**
 * Wallet resolution (STAGE F9, ISSUE-88): which credit bucket an app draws
 * from.
 *
 * Chain (exact, per the stage order): app.company_id → companies.owner_user_id.
 * An app with no company row (operator-provisioned legacy, and pre-F9 linked
 * apps) has no wallet owner and keeps drawing from app_credits exactly as
 * today — the dual-path rule's second path. Resolution is a pure function of
 * the app row, so pre-checks, in-transaction guards, refunds and awards all
 * derive the same bucket with no extra state.
 */
import type { FastifyInstance } from "fastify";

/** better-sqlite3 handle as exposed on the fastify instance. */
type Db = FastifyInstance["db"];

/**
 * @param db database handle
 * @param appRowId internal apps.id to resolve
 * @returns the owning user's id (wallet path: deduct from user_credits) or
 *          null (operator-legacy path: deduct from app_credits unchanged)
 */
export function resolveWalletOwner(db: Db, appRowId: string): string | null {
  const row = db
    .prepare(
      "SELECT c.owner_user_id AS user_id FROM apps a JOIN companies c ON c.id = a.company_id WHERE a.id = ?",
    )
    .get(appRowId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}
