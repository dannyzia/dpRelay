/**
 * Credit-award core (STAGE F5 extraction, ISSUE-83).
 *
 * The award used to live inline in the admin approve handler. The F5
 * payment-attach path (one-click confirm on the Payments screen) must mutate
 * balances EXACTLY the same way, and two copies of money code is how they
 * drift — so both routes now call this function.
 *
 * Money invariants (migration 006 / Addendum #1), preserved verbatim:
 * - The claim UPDATE (status flip) is the linearization point: a second
 *   concurrent caller sees changes !== 1 and must not award.
 * - Package details come from the request-time snapshot columns on the
 *   transaction row, never a live package lookup (v4 bug class).
 * - Expiry semantics: extend to max(current expiry, now + validity).
 */
import type { FastifyInstance } from "fastify";

/** better-sqlite3 handle as exposed on the fastify instance. */
type Db = FastifyInstance["db"];

/** Snapshot row the award reads (fetched while the transaction was pending). */
export interface AwardableTransaction {
  id: string;
  app_id: string;
  sms_quota: number;
  validity_days: number;
  package_type: string;
}

/**
 * Claims a pending credit transaction and awards its snapshot quota to the
 * app's credit buckets. MUST run inside the caller's `db.transaction(...)` so
 * the claim and the balance mutations commit (or roll back) together.
 *
 * @param db database handle (caller owns the wrapping transaction)
 * @param trx the pending transaction's snapshot columns
 * @returns true when this call claimed and awarded; false when the row was
 *          no longer pending (concurrent resolution — caller maps to 409)
 */
export function awardPendingTransaction(db: Db, trx: AwardableTransaction): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const newExpiry = nowSec + trx.validity_days * 24 * 60 * 60;

  const claimed = db
    .prepare(
      "UPDATE credit_transactions SET status = 'approved', resolved_by = 'operator', resolved_at = unixepoch() " +
        "WHERE id = ? AND status = 'pending'",
    )
    .run(trx.id);
  if (claimed.changes !== 1) return false;

  if (trx.package_type === "otp" || trx.package_type === "both") {
    db.prepare(
      "INSERT INTO app_credits (app_id, otp_sms_remaining, otp_expires_at, last_transaction_id, purchased_at, updated_at) " +
        "VALUES (?, ?, ?, ?, unixepoch(), unixepoch()) " +
        "ON CONFLICT(app_id) DO UPDATE SET " +
        "otp_sms_remaining = otp_sms_remaining + excluded.otp_sms_remaining, " +
        "otp_expires_at = MAX(COALESCE(otp_expires_at, 0), excluded.otp_expires_at), " +
        "last_transaction_id = excluded.last_transaction_id, " +
        "purchased_at = excluded.purchased_at, updated_at = excluded.updated_at",
    ).run(trx.app_id, trx.sms_quota, newExpiry, trx.id);
  }
  if (trx.package_type === "bulk" || trx.package_type === "both") {
    db.prepare(
      "INSERT INTO app_credits (app_id, bulk_sms_remaining, bulk_expires_at, last_transaction_id, purchased_at, updated_at) " +
        "VALUES (?, ?, ?, ?, unixepoch(), unixepoch()) " +
        "ON CONFLICT(app_id) DO UPDATE SET " +
        "bulk_sms_remaining = bulk_sms_remaining + excluded.bulk_sms_remaining, " +
        "bulk_expires_at = MAX(COALESCE(bulk_expires_at, 0), excluded.bulk_expires_at), " +
        "last_transaction_id = excluded.last_transaction_id, " +
        "purchased_at = excluded.purchased_at, updated_at = excluded.updated_at",
    ).run(trx.app_id, trx.sms_quota, newExpiry, trx.id);
  }
  return true;
}
