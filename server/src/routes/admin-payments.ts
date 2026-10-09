/**
 * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 prescriptive spec, hub event 1266) —
 * payments plane. Surfaces the bKash/Nagad payment-SMS ingestion
 * (POST /v5/device/payment-sms → payment_sms) to the operator panel with the
 * spec's four match states: unmatched | matched (proposed) | approved |
 * rejected.
 *
 * Auto-match rule (spec, exact): a payment proposes a match when its TrxID
 * equals the pending transaction's submitted TrxID (the join below), OR the
 * amount equals the package price exactly (within the tunable
 * payment_match_tolerance_bdt) AND the SMS arrived within ±
 * payment_match_window_min of the transaction creation. Both parameters are
 * admin_config rows read at request time (routes/admin-config.ts) — NEVER
 * hardcoded.
 *
 * Money safety (unchanged from ISSUE-83): NOTHING auto-awards. approve is
 * always a human click; it (or attach) re-validates amount, window, and
 * pending state INSIDE the same SQLite transaction that claims + awards, so
 * a stale panel or a racing operator can never award outside the rule or
 * twice. Awards go through the shared core (services/credits.ts), identical
 * to the admin billing approve path.
 *
 * The status rule lives in exactly ONE place (`deriveStatus`) — SQL only
 * filters dates; the candidate count needs the pending set anyway, and at
 * panel scale (bounded list, operator-only) post-fetch filtering costs
 * nothing. Filtering a heterogeneous CASE expression in SQL would mean
 * defining the rule twice.
 */
import type { FastifyPluginAsync } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { awardPendingTransaction } from "../services/credits.js";
import { readConfigValue } from "./admin-config.js";

/** Tunable match parameters, resolved at request time. */
interface MatchConfig {
  windowMin: number;
  windowSec: number;
  toleranceBdt: number;
  updatedAt: number;
}

/** Payment row as loaded from the join (before JS shaping). */
interface PaymentRow {
  id: string;
  sender: string;
  provider: string;
  /** STAGE F8 (ISSUE-90): ingest path — 'gateway' (OTP phone) | 'reader' (Payment Reader APK). */
  source: string;
  txn_id: string;
  amount_paisa: number;
  received_at: number;
  created_at: number;
  review_state: string | null;
  review_reason: string | null;
  matched_id: string | null;
  matched_status: string | null;
  matched_app_id: string | null;
  matched_notes: string | null;
}

interface PendingTxn {
  id: string;
  app_id: string;
  package_code: string;
  /** F5 amendment (ISSUE-89): the package's price currency (join on package_id). */
  currency: string;
  amount_bdt: number;
  requested_at: number;
  trx_id: string | null;
}

/** Structured failure returned from inside the attach/approve transaction. */
interface ActionError {
  status: number;
  code: string;
  error: string;
}

type ActionOutcome =
  | ActionError
  | {
      ok: true;
      transactionId: string;
      status: "approved";
      newOtpBalance: number;
      newBulkBalance: number;
    };

/** Parses a query value as a clamped integer (string or number input). */
function queryInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const PAYMENT_STATUSES = ["unmatched", "matched", "approved", "rejected"] as const;

const adminPaymentRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /** Reads both whitelisted match keys (admin_config) at request time. */
  function loadMatchConfig(): MatchConfig {
    const windowMin = readConfigValue(db, "payment_match_window_min");
    const toleranceBdt = readConfigValue(db, "payment_match_tolerance_bdt");
    const row = db
      .prepare(
        "SELECT MAX(updated_at) AS updated_at FROM admin_config " +
          "WHERE key IN ('payment_match_window_min', 'payment_match_tolerance_bdt')",
      )
      .get() as { updated_at: number | null } | undefined;
    return { windowMin, windowSec: windowMin * 60, toleranceBdt, updatedAt: row?.updated_at ?? 0 };
  }

  /**
   * Spec auto-match rule, second half (the TrxID half is the join: a pending
   * transaction holding this payment's TrxID IS the proposal). A pending
   * transaction is a candidate when it holds no TrxID yet (one already
   * committed elsewhere would 409 at attach time, so it is not actionable),
   * the amount is within tolerance (default 0 = exact), and the SMS arrived
   * within the window of the request.
   *
   * F5 amendment (ISSUE-89): CURRENCY-AWARE — only BDT-package transactions
   * are auto-match candidates. USD/EUR packages are paid via the remittance
   * rails as bKash BDT-equivalents, so amount/time arithmetic can never
   * prove they bought THAT package: they are MANUAL operator approvals by
   * design (approve with a remittance reference note) and must never be
   * auto-matched or auto-attached.
   */
  function isCandidate(p: { txnId: string; amountPaisa: number; receivedAt: number }, t: PendingTxn, cfg: MatchConfig): boolean {
    if (t.currency !== "BDT") return false;
    if (t.trx_id !== null) return false;
    if (Math.abs(t.amount_bdt * 100 - p.amountPaisa) > cfg.toleranceBdt * 100) return false;
    return Math.abs(p.receivedAt - t.requested_at) <= cfg.windowSec;
  }

  /** The single status rule (see file header). */
  function deriveStatus(row: PaymentRow, candidates: PendingTxn[]): (typeof PAYMENT_STATUSES)[number] {
    if (row.review_state === "rejected") return "rejected";
    if (row.matched_status === "approved") return "approved";
    if (row.matched_status === "rejected") return "rejected";
    if (row.matched_status === "pending") return "matched";
    // Proposed: exactly one actionable candidate. Ambiguity (>1) is
    // surfaced as unmatched + the explicit picker — never auto-resolved.
    return candidates.length === 1 ? "matched" : "unmatched";
  }

  /**
   * Attaches + awards one payment → transaction, re-validating EVERYTHING
   * inside the caller's transaction (spec: approve re-validates amount,
   * window, and pending state inside the award transaction). Shared by
   * attach and approve so the money path exists exactly once.
   */
  function attachAndAward(
    payment: { id: string; txn_id: string; amount_paisa: number; received_at: number },
    transactionId: string,
    cfg: MatchConfig,
  ): ActionOutcome {
    const holder = db
      .prepare("SELECT id, status FROM credit_transactions WHERE trx_id = ?")
      .get(payment.txn_id) as { id: string; status: string } | undefined;
    if (holder) {
      if (holder.id === transactionId && holder.status === "approved") {
        return { status: 409, code: "payment_already_approved", error: "This payment is already approved" };
      }
      if (holder.id !== transactionId) {
        return { status: 409, code: "trx_id_exists", error: "This TrxID is already attached to another transaction" };
      }
    }
    const trx = db
      .prepare(
        "SELECT id, app_id, user_id, sms_quota, validity_days, package_type, status, amount_bdt, requested_at, trx_id " +
          "FROM credit_transactions WHERE id = ?",
      )
      .get(transactionId) as
      | {
          id: string;
          app_id: string | null;
          user_id: string | null;
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
      // concurrent holder of this TrxID throw, caught by the caller → 409.
      db.prepare("UPDATE credit_transactions SET trx_id = ? WHERE id = ? AND status = 'pending'").run(
        payment.txn_id,
        transactionId,
      );
    }
    if (!awardPendingTransaction(db, trx)) {
      return { status: 409, code: "already_resolved", error: "Transaction already resolved" };
    }
    // Review state rides the SAME transaction: either the click awarded AND
    // marked the row, or neither happened.
    db.prepare(
      "UPDATE payment_sms SET review_state = 'approved', review_reason = NULL, reviewed_at = unixepoch() WHERE id = ?",
    ).run(payment.id);
    // STAGE F9 (ISSUE-88): the reported balance must be the plane the award
    // actually landed on — user wallet or app bucket, by attribution.
    const credits =
      trx.user_id !== null
        ? (db
            .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM user_credits WHERE user_id = ?")
            .get(trx.user_id) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined)
        : (db
            .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM app_credits WHERE app_id = ?")
            .get(trx.app_id) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined);
    app.log.info({ paymentId: payment.id, transactionId, txnId: payment.txn_id }, "payment attached + credits awarded");
    return {
      ok: true,
      transactionId,
      status: "approved",
      newOtpBalance: credits?.otp_sms_remaining ?? 0,
      newBulkBalance: credits?.bulk_sms_remaining ?? 0,
    };
  }

  /** Runs the shared action + maps thrown UNIQUE violations to 409s. */
  function runAction(
    payment: { id: string; txn_id: string; amount_paisa: number; received_at: number },
    transactionId: string,
    cfg: MatchConfig,
  ): ActionOutcome {
    const run = db.transaction(() => attachAndAward(payment, transactionId, cfg));
    try {
      return run();
    } catch (err) {
      if (String(err).includes("credit_transactions.trx_id")) {
        return {
          status: 409,
          code: "trx_id_exists",
          error: "This TrxID is already attached to another transaction",
        };
      }
      throw err;
    }
  }

  /**
   * Operator payments view (spec screen `#/operator/payments`): ingested
   * payment SMS newest-first with match-status, stored reject reason, and —
   * for unmatched rows — the candidate pending transactions computed under
   * the current tunable config.
   */
  app.get("/v5/admin/payments", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const cfg = loadMatchConfig();
    const query = asRecord(request.query) ?? {};
    const limit = queryInt(query.limit, 200, 1, 1000);

    const statusRaw = query.status;
    const statusFilter =
      statusRaw === undefined || statusRaw === "" ? null : String(statusRaw);
    if (statusFilter !== null && !PAYMENT_STATUSES.includes(statusFilter as (typeof PAYMENT_STATUSES)[number])) {
      return reply.code(400).send({
        ok: false,
        error: `status must be one of ${PAYMENT_STATUSES.join("|")}`,
        code: "invalid_status",
      });
    }

    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const from = queryInt(query.from, 0, 0, Number.MAX_SAFE_INTEGER);
    const to = queryInt(query.to, 0, 0, Number.MAX_SAFE_INTEGER);
    if (query.from !== undefined && String(query.from) !== "") {
      clauses.push("ps.received_at >= ?");
      params.push(from);
    }
    if (query.to !== undefined && String(query.to) !== "") {
      clauses.push("ps.received_at <= ?");
      params.push(to);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = db
      .prepare(
        "SELECT ps.id, ps.sender, ps.provider, ps.source, ps.txn_id, ps.amount_paisa, ps.received_at, ps.created_at, " +
          "ps.review_state, ps.review_reason, " +
          "ct.id AS matched_id, ct.status AS matched_status, ct.app_id AS matched_app_id, " +
          "ct.admin_notes AS matched_notes " +
          "FROM payment_sms ps " +
          "LEFT JOIN credit_transactions ct ON ct.trx_id = ps.txn_id " +
          `${where} ORDER BY ps.received_at DESC, ps.created_at DESC LIMIT ?`,
      )
      .all(...params, limit) as PaymentRow[];

    const pending = db
      .prepare(
        "SELECT t.id, t.app_id, t.package_code, p.currency, t.amount_bdt, t.requested_at, t.trx_id " +
          "FROM credit_transactions t JOIN packages p ON p.id = t.package_id " +
          "WHERE t.status = 'pending' ORDER BY t.requested_at ASC",
      )
      .all() as PendingTxn[];

    const payments = rows
      .map((r) => {
        const base = { txnId: r.txn_id, amountPaisa: r.amount_paisa, receivedAt: r.received_at };
        const candidates =
          r.matched_id !== null
            ? []
            : pending.filter((t) => isCandidate(base, t, cfg));
        const status = deriveStatus(r, candidates);
        return {
          id: r.id,
          sender: r.sender,
          provider: r.provider,
          source: r.source,
          txnId: r.txn_id,
          amountBdt: r.amount_paisa / 100,
          receivedAt: r.received_at,
          createdAt: r.created_at,
          status,
          reason: r.review_state === "rejected" ? r.review_reason : r.matched_status === "rejected" ? r.matched_notes : null,
          matched:
            r.matched_id !== null
              ? { transactionId: r.matched_id, status: r.matched_status, appId: r.matched_app_id }
              : null,
          candidates: candidates.map((t) => ({
            transactionId: t.id,
            appId: t.app_id,
            packageCode: t.package_code,
            amountBdt: t.amount_bdt,
            requestedAt: t.requested_at,
            deltaBdt: Math.abs(t.amount_bdt * 100 - r.amount_paisa) / 100,
            timeDeltaSec: Math.abs(r.received_at - t.requested_at),
          })),
          ambiguous: candidates.length > 1,
        };
      })
      .filter((p) => statusFilter === null || p.status === statusFilter);

    return { ok: true, config: cfg, payments };
  });

  /**
   * One-click Approve (spec): awards the proposed/attached transaction and
   * marks the row approved. The target transaction is explicit when the
   * TrxID matched; for a single-candidate proposal it is derived under the
   * same rule and re-validated inside the award transaction. Ambiguity is
   * never resolved implicitly — that is what the attach picker is for.
   */
  app.post("/v5/admin/payments/:id/approve", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const paymentId = asString(params.id, 64);
    if (paymentId === null) {
      return reply.code(400).send({ ok: false, error: "payment id is required", code: "invalid_payment_id" });
    }
    const payment = db
      .prepare(
        "SELECT id, txn_id, amount_paisa, received_at, review_state FROM payment_sms WHERE id = ?",
      )
      .get(paymentId) as
      | { id: string; txn_id: string; amount_paisa: number; received_at: number; review_state: string | null }
      | undefined;
    if (!payment) {
      return reply.code(404).send({ ok: false, error: "Payment SMS not found", code: "payment_not_found" });
    }
    if (payment.review_state === "rejected") {
      return reply.code(409).send({
        ok: false,
        error: "This payment was rejected — a rejected row cannot be approved",
        code: "payment_rejected",
      });
    }
    const cfg = loadMatchConfig();

    // Target: the transaction already holding this TrxID, else the single
    // candidate under the current rule (0 → transaction_required, >1 →
    // ambiguous_match: the operator must use the attach picker).
    const holder = db
      .prepare("SELECT id, status FROM credit_transactions WHERE trx_id = ?")
      .get(payment.txn_id) as { id: string; status: string } | undefined;
    let targetId: string;
    if (holder) {
      if (holder.status === "approved") {
        return reply.code(409).send({
          ok: false,
          error: "This payment is already approved",
          code: "payment_already_approved",
        });
      }
      targetId = holder.id;
    } else {
      const pending = db
        .prepare(
          "SELECT t.id, t.app_id, t.package_code, p.currency, t.amount_bdt, t.requested_at, t.trx_id " +
            "FROM credit_transactions t JOIN packages p ON p.id = t.package_id " +
            "WHERE t.status = 'pending' ORDER BY t.requested_at ASC",
        )
        .all() as PendingTxn[];
      const base = { txnId: payment.txn_id, amountPaisa: payment.amount_paisa, receivedAt: payment.received_at };
      const candidates = pending.filter((t) => isCandidate(base, t, cfg));
      if (candidates.length === 0) {
        return reply.code(409).send({
          ok: false,
          error: "No matching pending transaction — attach explicitly first",
          code: "transaction_required",
        });
      }
      if (candidates.length > 1) {
        return reply.code(409).send({
          ok: false,
          error: `${candidates.length} transactions match — choose explicitly with Attach`,
          code: "ambiguous_match",
        });
      }
      targetId = candidates[0]?.id ?? "";
    }

    const outcome = runAction(payment, targetId, cfg);
    if (!("ok" in outcome)) {
      return reply.code(outcome.status).send({ ok: false, error: outcome.error, code: outcome.code });
    }
    return outcome;
  });

  /**
   * Reject (spec): requires a reason string, stores it on the row (shown in
   * the panel), and detaches a pending transaction's TrxID so the customer's
   * real claim is not stranded on evidence the operator just rejected.
   * An approved transaction can never be undone from here (409).
   */
  app.post("/v5/admin/payments/:id/reject", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const paymentId = asString(params.id, 64);
    const body = asRecord(request.body) ?? {};
    const reason = asString(body.reason, 512);
    if (paymentId === null) {
      return reply.code(400).send({ ok: false, error: "payment id is required", code: "invalid_payment_id" });
    }
    if (reason === null || reason.trim() === "") {
      return reply.code(400).send({ ok: false, error: "reason is required", code: "reason_required" });
    }
    const payment = db.prepare("SELECT id FROM payment_sms WHERE id = ?").get(paymentId) as
      | { id: string }
      | undefined;
    if (!payment) {
      return reply.code(404).send({ ok: false, error: "Payment SMS not found", code: "payment_not_found" });
    }

    const run = db.transaction((): ActionError | { ok: true; paymentId: string; status: "rejected"; reason: string } => {
      const holder = db
        .prepare(
          "SELECT ct.id, ct.status FROM credit_transactions ct WHERE ct.trx_id = " +
            "(SELECT txn_id FROM payment_sms WHERE id = ?)",
        )
        .get(paymentId) as { id: string; status: string } | undefined;
      if (holder?.status === "approved") {
        return {
          status: 409,
          code: "payment_already_approved",
          error: "Credits were already awarded for this payment — reject is not an undo",
        };
      }
      if (holder?.status === "pending") {
        // Free the customer's claim: the rejected evidence's TrxID must not
        // keep occupying the pending transaction (submit-trx would 409 a
        // corrected TrxID otherwise).
        db.prepare(
          "UPDATE credit_transactions SET trx_id = NULL WHERE id = ? AND status = 'pending'",
        ).run(holder.id);
      }
      db.prepare(
        "UPDATE payment_sms SET review_state = 'rejected', review_reason = ?, reviewed_at = unixepoch() WHERE id = ?",
      ).run(reason.trim(), paymentId);
      app.log.info({ paymentId, reason: reason.trim() }, "payment rejected");
      return { ok: true, paymentId, status: "rejected", reason: reason.trim() };
    });

    const outcome = run();
    if (!("ok" in outcome)) {
      return reply.code(outcome.status).send({ ok: false, error: outcome.error, code: outcome.code });
    }
    return outcome;
  });

  /**
   * Explicit Attach (spec: unmatched rows get an "Attach to transaction…"
   * picker). The transactionId IS the operator's ambiguity resolution; every
   * validation re-runs inside the award transaction via attachAndAward.
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
      .prepare("SELECT id, txn_id, amount_paisa, received_at, review_state FROM payment_sms WHERE id = ?")
      .get(paymentId) as
      | { id: string; txn_id: string; amount_paisa: number; received_at: number; review_state: string | null }
      | undefined;
    if (!payment) {
      return reply.code(404).send({ ok: false, error: "Payment SMS not found", code: "payment_not_found" });
    }
    if (payment.review_state === "rejected") {
      return reply.code(409).send({
        ok: false,
        error: "This payment was rejected — attach is unavailable",
        code: "payment_rejected",
      });
    }
    const cfg = loadMatchConfig();
    const outcome = runAction(payment, transactionId, cfg);
    if (!("ok" in outcome)) {
      return reply.code(outcome.status).send({ ok: false, error: outcome.error, code: outcome.code });
    }
    return outcome;
  });
};

export default adminPaymentRoutes;
