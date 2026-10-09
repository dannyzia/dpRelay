/**
 * STAGE F5 (ISSUE-83) — payments plane. Surfaces the bKash/Nagad payment-SMS
 * ingestion (POST /v5/device/payment-sms → payment_sms) to the operator panel
 * and PROPOSES amount+window matches against pending credit transactions.
 *
 * Matching rules (hub event 1213):
 * - Tolerance and time window come from payment_match_config (migration 014,
 *   operator-tunable, read at request time) — NEVER hardcoded here.
 * - Nothing ever auto-awards. The list computes candidates per unmatched SMS;
 *   the one-click confirm (attach) REQUIRES an explicit transactionId and
 *   re-validates amount, window, and pending state inside the same SQLite
 *   transaction that claims + awards. Ambiguity (>1 candidate) is surfaced to
 *   the operator, never resolved implicitly.
 * - Awards go through the shared award core (services/credits.ts), identical
 *   to the admin approve path.
 */
import type { FastifyPluginAsync } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { awardPendingTransaction } from "../services/credits.js";

interface MatchConfigRow {
  tolerance_bdt: number;
  window_sec: number;
  updated_at: number;
}

/** Structured failure returned from inside the attach transaction. */
interface AttachError {
  status: number;
  code: string;
  error: string;
}

/** Parses a query value as a clamped integer (string or number input). */
function queryInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const adminPaymentRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Reads the singleton match config. Migration 014 seeds the row on every
   * boot; the fallback mirrors those seed values only so a hypothetical
   * missing row degrades instead of 500ing (values live in the migration —
   * the operator tunes them here, per the hub flag).
   */
  function loadMatchConfig(): { toleranceBdt: number; windowSec: number; updatedAt: number } {
    const row = db
      .prepare("SELECT tolerance_bdt, window_sec, updated_at FROM payment_match_config WHERE id = 1")
      .get() as MatchConfigRow | undefined;
    if (row) return { toleranceBdt: row.tolerance_bdt, windowSec: row.window_sec, updatedAt: row.updated_at };
    return { toleranceBdt: 100, windowSec: 604800, updatedAt: 0 };
  }

  /** GET the tunable match parameters (Payments panel settings display). */
  app.get("/v5/admin/payments/config", { preHandler: [app.requireOperator] }, async () => {
    return { ok: true, ...loadMatchConfig() };
  });

  /**
   * PUT the tunable match parameters — at least one field, integer ranges
   * bounded so a typo cannot pin the proposal engine to a meaningless value.
   */
  app.put("/v5/admin/payments/config", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const sets: string[] = [];
    const values: number[] = [];
    if (body.toleranceBdt !== undefined) {
      const t = body.toleranceBdt;
      if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t > 1_000_000) {
        return reply.code(400).send({
          ok: false,
          error: "toleranceBdt must be an integer between 0 and 1000000",
          code: "invalid_match_config",
        });
      }
      sets.push("tolerance_bdt = ?");
      values.push(t);
    }
    if (body.windowSec !== undefined) {
      const w = body.windowSec;
      if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 31_536_000) {
        return reply.code(400).send({
          ok: false,
          error: "windowSec must be an integer between 0 and 31536000 (1 year)",
          code: "invalid_match_config",
        });
      }
      sets.push("window_sec = ?");
      values.push(w);
    }
    if (sets.length === 0) {
      return reply.code(400).send({
        ok: false,
        error: "toleranceBdt and/or windowSec required",
        code: "invalid_match_config",
      });
    }
    sets.push("updated_at = unixepoch()");
    db.prepare(`UPDATE payment_match_config SET ${sets.join(", ")} WHERE id = 1`).run(...values);
    app.log.info({ fields: Object.keys(body) }, "payment match config updated");
    return { ok: true, ...loadMatchConfig() };
  });

  /**
   * Operator payments view: ingested payment SMS newest-first, each with its
   * match status and — for unmatched rows — the candidate pending
   * transactions computed under the current tunable config. `ambiguous` marks
   * the rows where more than one pending transaction matches: the panel must
   * make the operator choose explicitly.
   */
  app.get("/v5/admin/payments", { preHandler: [app.requireOperator] }, async (request) => {
    const cfg = loadMatchConfig();
    const query = asRecord(request.query) ?? {};
    const limit = queryInt(query.limit, 200, 1, 1000);

    const rows = db
      .prepare(
        "SELECT ps.id, ps.sender, ps.provider, ps.txn_id, ps.amount_paisa, ps.received_at, ps.created_at, " +
          "ct.id AS matched_id, ct.status AS matched_status, ct.app_id AS matched_app_id " +
          "FROM payment_sms ps " +
          "LEFT JOIN credit_transactions ct ON ct.trx_id = ps.txn_id " +
          "ORDER BY ps.received_at DESC, ps.created_at DESC LIMIT ?",
      )
      .all(limit) as {
      id: string;
      sender: string;
      provider: string;
      txn_id: string;
      amount_paisa: number;
      received_at: number;
      created_at: number;
      matched_id: string | null;
      matched_status: string | null;
      matched_app_id: string | null;
    }[];

    const pending = db
      .prepare(
        "SELECT id, app_id, package_code, amount_bdt, requested_at FROM credit_transactions " +
          "WHERE status = 'pending' ORDER BY requested_at ASC",
      )
      .all() as {
      id: string;
      app_id: string;
      package_code: string;
      amount_bdt: number;
      requested_at: number;
    }[];

    const tolerancePaisa = cfg.toleranceBdt * 100;
    const payments = rows.map((r) => {
      const matched =
        r.matched_id !== null
          ? { transactionId: r.matched_id, status: r.matched_status, appId: r.matched_app_id }
          : null;
      const candidates =
        matched !== null
          ? []
          : pending
              .map((t) => ({
                transactionId: t.id,
                appId: t.app_id,
                packageCode: t.package_code,
                amountBdt: t.amount_bdt,
                requestedAt: t.requested_at,
                deltaBdt: Math.abs(t.amount_bdt * 100 - r.amount_paisa) / 100,
                timeDeltaSec: Math.abs(r.received_at - t.requested_at),
              }))
              .filter(
                (t) =>
                  Math.abs(t.amountBdt * 100 - r.amount_paisa) <= tolerancePaisa &&
                  t.timeDeltaSec <= cfg.windowSec,
              );
      return {
        id: r.id,
        sender: r.sender,
        provider: r.provider,
        txnId: r.txn_id,
        amountBdt: r.amount_paisa / 100,
        receivedAt: r.received_at,
        createdAt: r.created_at,
        matched,
        candidates,
        ambiguous: candidates.length > 1,
      };
    });

    return { ok: true, config: cfg, payments };
  });

  /**
   * One-click confirm: attach this payment SMS's TrxID to the explicitly
   * chosen pending transaction and award its credits — atomically. The
   * explicit transactionId IS the operator's ambiguity resolution; every
   * validation re-runs inside the transaction, so a stale panel or a racing
   * operator can never award outside tolerance/window or double-award.
   */
  app.post("/v5/admin/payments/:id/attach", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const paymentId = asString(params.id, 64);
    const body = asRecord(request.body) ?? {};
    const transactionId = asString(body.transactionId, 64);
    if (paymentId === null) {
      return reply.code(400).send({ ok: false, error: "payment id is required", code: "invalid_payment_id" });
    }
    if (transactionId === null) {
      return reply.code(400).send({
        ok: false,
        error: "transactionId is required — the operator chooses explicitly, ambiguity never auto-resolves",
        code: "transaction_required",
      });
    }
    const payment = db
      .prepare("SELECT id, txn_id, amount_paisa, received_at FROM payment_sms WHERE id = ?")
      .get(paymentId) as
      | { id: string; txn_id: string; amount_paisa: number; received_at: number }
      | undefined;
    if (!payment) {
      return reply.code(404).send({ ok: false, error: "Payment SMS not found", code: "payment_not_found" });
    }
    const cfg = loadMatchConfig();

    const run = db.transaction(():
      | AttachError
      | {
          ok: true;
          transactionId: string;
          status: "approved";
          newOtpBalance: number;
          newBulkBalance: number;
        } => {
      // Already attached to ANY transaction? (partial UNIQUE index backs this;
      // the check is here to answer with a structured conflict, not a 500.)
      const holder = db
        .prepare("SELECT id, status FROM credit_transactions WHERE trx_id = ?")
        .get(payment.txn_id) as { id: string; status: string } | undefined;
      if (holder) {
        if (holder.id === transactionId && holder.status === "approved") {
          return { status: 409, code: "payment_already_attached", error: "This payment is already attached" };
        }
        if (holder.id !== transactionId) {
          return { status: 409, code: "trx_id_exists", error: "This TrxID is already attached to another transaction" };
        }
      }
      const trx = db
        .prepare(
          "SELECT id, app_id, sms_quota, validity_days, package_type, status, amount_bdt, requested_at, trx_id " +
            "FROM credit_transactions WHERE id = ?",
        )
        .get(transactionId) as
        | {
            id: string;
            app_id: string;
            sms_quota: number;
            validity_days: number;
            package_type: string;
            status: string;
            amount_bdt: number;
            requested_at: number;
            trx_id: string | null;
          }
        | undefined;
      if (!trx) return { status: 404, code: "transaction_not_found", error: "Transaction not found" };
      if (trx.status !== "pending") {
        return { status: 409, code: "already_resolved", error: `Transaction already resolved with status: ${trx.status}` };
      }
      if (trx.trx_id !== null && trx.trx_id !== payment.txn_id) {
        return { status: 409, code: "trx_conflict", error: "Transaction already holds a different TrxID" };
      }
      const tolerancePaisa = cfg.toleranceBdt * 100;
      const amountDeltaPaisa = Math.abs(trx.amount_bdt * 100 - payment.amount_paisa);
      if (amountDeltaPaisa > tolerancePaisa) {
        return {
          status: 409,
          code: "amount_out_of_tolerance",
          error: `Amount differs by ${(amountDeltaPaisa / 100).toFixed(2)} BDT (tolerance ${cfg.toleranceBdt} BDT)`,
        };
      }
      const timeDeltaSec = Math.abs(payment.received_at - trx.requested_at);
      if (timeDeltaSec > cfg.windowSec) {
        return {
          status: 409,
          code: "outside_time_window",
          error: `Payment is ${timeDeltaSec}s from the request (window ${cfg.windowSec}s)`,
        };
      }
      if (trx.trx_id === null) {
        // Attaching inside the transaction: the partial UNIQUE index makes a
        // concurrent holder of this TrxID throw, caught below → 409.
        db.prepare("UPDATE credit_transactions SET trx_id = ? WHERE id = ? AND status = 'pending'").run(
          payment.txn_id,
          transactionId,
        );
      }
      if (!awardPendingTransaction(db, trx)) {
        return { status: 409, code: "already_resolved", error: "Transaction already resolved" };
      }
      const credits = db
        .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM app_credits WHERE app_id = ?")
        .get(trx.app_id) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined;
      app.log.info({ paymentId, transactionId, txnId: payment.txn_id }, "payment attached + credits awarded");
      return {
        ok: true,
        transactionId,
        status: "approved",
        newOtpBalance: credits?.otp_sms_remaining ?? 0,
        newBulkBalance: credits?.bulk_sms_remaining ?? 0,
      };
    });

    let outcome: ReturnType<typeof run>;
    try {
      outcome = run();
    } catch (err) {
      if (String(err).includes("credit_transactions.trx_id")) {
        return reply.code(409).send({
          ok: false,
          error: "This TrxID is already attached to another transaction",
          code: "trx_id_exists",
        });
      }
      throw err;
    }
    if (!("ok" in outcome)) {
      const e = outcome;
      return reply.code(e.status).send({ ok: false, error: e.error, code: e.code });
    }
    return outcome;
  });
};

export default adminPaymentRoutes;
