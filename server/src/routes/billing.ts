/**
 * M4 pass 1 — billing plane (PLAN.md §10, Addendum #1). Port of the v4
 * Firestore billing handlers to v5 REST, re-scoped to v5 auth realities:
 *
 * - App-facing routes (packages list, credits, transactions, invoice, request,
 *   submit-trx) gate via requireApp (X-App-Id/X-App-Secret) — v4 checked
 *   Firebase uid ownership, but v5 apps have no owner until the self-serve
 *   onboarding milestone (ISSUE-11 decision), so the app credential IS the
 *   tenant scope.
 * - Admin routes (package upsert, approve/reject) gate via the new
 *   requireOperator middleware (OPERATOR_SECRET), generalizing the ISSUE-11
 *   operator pattern for the M4 admin plane.
 *
 * Money correctness (Addendum #1):
 * - Credits are awarded ONLY via admin approval of a pending transaction.
 * - One TrxID can be attached to one transaction ever: enforced by the
 *   partial UNIQUE index (migration 006) AND re-checked before submit.
 * - The award transaction re-checks pending state inside the same SQLite
 *   transaction that mutates balances — a double-approve races to a 409,
 *   never to a double award. package details come from the request-time
 *   snapshot columns, not a live package lookup (v4 bug class closed).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { newId } from "../services/crypto.js";

/** Parses an ISO-8601 date/datetime query value into epoch SECONDS (null if absent/invalid). */
function parseDateBound(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** Rejects a 400 with the structured envelope. */
function reject400(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, error: message, code });
}

interface UpsertPackageBody {
  packageCode?: unknown;
  name?: unknown;
  smsQuota?: unknown;
  priceBdt?: unknown;
  validityDays?: unknown;
  type?: unknown;
  isActive?: unknown;
}

interface ApproveBody {
  transactionId?: unknown;
  approve?: unknown;
  rejectReason?: unknown;
}

const PACKAGE_CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

const billingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  // ── App-facing routes (requireApp = tenant scope) ────────────────────────

  /**
   * Public catalog: active packages for callers without credentials. v4
   * required auth even to list packages; requiring app credentials for a
   * price list adds nothing (no PII, no entitlement) and blocks storefronts.
   * Ordering mirrors v4: type group (otp → bulk → both), then price ascending.
   */
  app.get("/v5/billing/packages", async () => {
    const rows = db
      .prepare(
        "SELECT package_code, name, sms_quota, price_bdt, validity_days, type " +
          "FROM packages WHERE is_active = 1",
      )
      .all() as {
      package_code: string;
      name: string;
      sms_quota: number;
      price_bdt: number;
      validity_days: number;
      type: string;
    }[];
    const typeOrder: Record<string, number> = { otp: 0, bulk: 1, both: 2 };
    rows.sort(
      (a, b) =>
        (typeOrder[a.type] ?? 0) - (typeOrder[b.type] ?? 0) ||
        a.price_bdt - b.price_bdt,
    );
    return {
      ok: true,
      packages: rows.map((r) => ({
        packageCode: r.package_code,
        name: r.name,
        smsQuota: r.sms_quota,
        priceBdt: r.price_bdt,
        validityDays: r.validity_days,
        type: r.type,
      })),
    };
  });

  /** Current credit balance for the authenticated app (v4 getCredits). */
  app.get("/v5/billing/credits", { preHandler: [app.requireApp] }, async (request) => {
    const appId = request.appRow?.id ?? "";
    const row = db
      .prepare(
        "SELECT otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, " +
          "last_transaction_id, purchased_at FROM app_credits WHERE app_id = ?",
      )
      .get(appId) as
      | {
          otp_sms_remaining: number;
          bulk_sms_remaining: number;
          otp_expires_at: number | null;
          bulk_expires_at: number | null;
          last_transaction_id: string | null;
          purchased_at: number | null;
        }
      | undefined;
    return {
      ok: true,
      credits: {
        otpSmsRemaining: row?.otp_sms_remaining ?? 0,
        bulkSmsRemaining: row?.bulk_sms_remaining ?? 0,
        otpExpiresAt: row?.otp_expires_at ?? null,
        bulkExpiresAt: row?.bulk_expires_at ?? null,
        lastTransactionId: row?.last_transaction_id ?? null,
        purchasedAt: row?.purchased_at ?? null,
      },
    };
  });

  /** Transaction history for the authenticated app (v4 getTransactions). */
  app.get("/v5/billing/transactions", { preHandler: [app.requireApp] }, async (request, reply) => {
    const appId = request.appRow?.id ?? "";
    const body = asRecord(request.body) ?? {};
    const query = asRecord(request.query) ?? {};
    const statusRaw = query.status ?? body.status;
    const status =
      statusRaw === "pending" || statusRaw === "approved" || statusRaw === "rejected"
        ? statusRaw
        : null;
    if (statusRaw !== undefined && status === null) {
      return reply.code(400).send({
        ok: false,
        error: "status must be one of pending|approved|rejected",
        code: "invalid_status",
      });
    }
    // Fastify query params arrive as STRINGS — accept both shapes or
    // `?limit=2` would silently fall back to the default page size.
    const limitRaw = query.limit ?? body.limit;
    const limitNum =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Number.parseInt(limitRaw, 10)
          : NaN;
    const limit =
      Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, 100) : 20;
    // Keyset pagination: cursor is "requested_at:id" of the previous page's
    // last row. The id tiebreaker is REQUIRED — rows created within the same
    // unixepoch() second share a timestamp, and a timestamp-only cursor
    // silently drops them. WHERE mirrors ORDER BY (requested_at DESC, id ASC)
    // so pages are strictly advancing and lossless.
    const cursorRaw = query.cursor ?? body.cursor;
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
        "SELECT id, package_code, sms_quota, validity_days, amount_bdt, package_type, " +
          "trx_id, status, admin_notes, requested_at, resolved_at " +
          "FROM credit_transactions WHERE app_id = ? " +
          "AND (? IS NULL OR status = ?) " +
          "AND (? IS NULL OR requested_at < ? OR (requested_at = ? AND id > ?)) " +
          "ORDER BY requested_at DESC, id ASC LIMIT ?",
      )
      .all(
        appId,
        status,
        status,
        cursorAt,
        cursorAt,
        cursorAt,
        cursorId,
        limit + 1,
      ) as {
      id: string;
      package_code: string;
      sms_quota: number;
      validity_days: number;
      amount_bdt: number;
      package_type: string;
      trx_id: string | null;
      status: string;
      admin_notes: string | null;
      requested_at: number;
      resolved_at: number | null;
    }[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      transactions: page.map((t) => ({
        transactionId: t.id,
        packageCode: t.package_code,
        smsQuota: t.sms_quota,
        validityDays: t.validity_days,
        amountBdt: t.amount_bdt,
        packageType: t.package_type,
        trxId: t.trx_id,
        status: t.status,
        adminNotes: t.admin_notes,
        requestedAt: t.requested_at,
        resolvedAt: t.resolved_at,
      })),
      nextCursor: hasMore
        ? `${page[page.length - 1]?.requested_at ?? 0}:${page[page.length - 1]?.id ?? ""}`
        : null,
    };
  });

  /**
   * Invoice summary for a date range (v4 getInvoiceHistory): approved
   * purchases in the window plus an aggregate. OTP/bulk usage rows arrive
   * with the campaigns pass (M4 pass 3) — the summary shape already carries
   * the keys so the contract does not change later.
   */
  app.get("/v5/billing/invoice", { preHandler: [app.requireApp] }, async (request, reply) => {
    const appId = request.appRow?.id ?? "";
    const query = asRecord(request.query) ?? {};
    // resolved_at is epoch SECONDS; the default window must be too, or the
    // comparison silently excludes every real transaction (ms vs s scale).
    const nowSec = Math.floor(Date.now() / 1000);
    const start = parseDateBound(query.startDate) ?? nowSec - 30 * 24 * 60 * 60;
    const end = parseDateBound(query.endDate) ?? nowSec;
    if (start > end) {
      return reply.code(400).send({
        ok: false,
        error: "startDate must be before endDate",
        code: "invalid_date_range",
      });
    }
    const purchases = db
      .prepare(
        "SELECT id, package_code, amount_bdt, package_type, sms_quota, resolved_at " +
          "FROM credit_transactions " +
          "WHERE app_id = ? AND status = 'approved' AND resolved_at IS NOT NULL " +
          "AND resolved_at >= ? AND resolved_at <= ? ORDER BY resolved_at DESC",
      )
      .all(appId, start, end) as {
      id: string;
      package_code: string;
      amount_bdt: number;
      package_type: string;
      sms_quota: number;
      resolved_at: number;
    }[];
    return {
      ok: true,
      purchases: purchases.map((p) => ({
        transactionId: p.id,
        packageCode: p.package_code,
        amountBdt: p.amount_bdt,
        packageType: p.package_type,
        smsQuota: p.sms_quota,
        approvedAt: p.resolved_at,
      })),
      summary: {
        totalPurchases: purchases.length,
        totalAmountBdt: purchases.reduce((n, p) => n + p.amount_bdt, 0),
        totalOtpUsed: 0,
        totalBulkSent: 0,
      },
    };
  });

  /**
   * Initiate a credit purchase (v4 requestCredit): creates a pending
   * transaction snapshotting the package, and returns the bKash destination.
   * Fails closed when BKASH_PERSONAL_NUMBER is unset — a request whose payment
   * destination cannot be told to the customer must not exist.
   */
  app.post("/v5/billing/credits/request", { preHandler: [app.requireApp] }, async (request, reply) => {
    if (app.config.bkashPersonalNumber === "") {
      return reply.code(503).send({
        ok: false,
        error: "Payment destination is not configured",
        code: "payment_destination_unconfigured",
      });
    }
    const body = (asRecord(request.body) ?? {}) as { packageCode?: unknown };
    const packageCode = asString(body.packageCode, 64);
    if (packageCode === null) {
      return reject400(reply, "invalid_package_code", "packageCode is required");
    }
    const pkg = db
      .prepare(
        "SELECT id, sms_quota, validity_days, price_bdt, type FROM packages " +
          "WHERE package_code = ? AND is_active = 1",
      )
      .get(packageCode) as
      | { id: string; sms_quota: number; validity_days: number; price_bdt: number; type: string }
      | undefined;
    if (!pkg) {
      return reply.code(404).send({
        ok: false,
        error: "Package not found or inactive",
        code: "package_not_found",
      });
    }
    const transactionId = newId();
    db.prepare(
      "INSERT INTO credit_transactions " +
        "(id, app_id, package_id, package_code, sms_quota, validity_days, amount_bdt, " +
        "package_type, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch())",
    ).run(
      transactionId,
      request.appRow?.id,
      pkg.id,
      packageCode,
      pkg.sms_quota,
      pkg.validity_days,
      pkg.price_bdt,
      pkg.type,
    );
    app.log.info({ appId: request.appRow?.appId, transactionId, packageCode }, "credit requested");
    return reply.code(201).send({
      ok: true,
      transactionId,
      bkashNumber: app.config.bkashPersonalNumber,
      bkashNote: "Send Money",
      amountBdt: pkg.price_bdt,
    });
  });

  /**
   * Attach the bKash TrxID to a pending transaction (v4 submitTrxId). The
   * partial UNIQUE index rejects a TrxID already on any other transaction;
   * this handler also rejects a TrxID already on an APPROVED one with a
   * clearer 409 before the database has to.
   */
  app.post("/v5/billing/credits/submit-trx", { preHandler: [app.requireApp] }, async (request, reply) => {
    const body = (asRecord(request.body) ?? {}) as {
      transactionId?: unknown;
      trxId?: unknown;
    };
    const transactionId = asString(body.transactionId, 64);
    const trxId = typeof body.trxId === "string" ? body.trxId.trim() : null;
    if (transactionId === null || trxId === null || trxId.length === 0) {
      return reply.code(400).send({
        ok: false,
        error: "transactionId and trxId are required",
        code: "invalid_request",
      });
    }
    const row = db
      .prepare("SELECT status, trx_id FROM credit_transactions WHERE id = ? AND app_id = ?")
      .get(transactionId, request.appRow?.id) as { status: string; trx_id: string | null } | undefined;
    if (!row) {
      return reply.code(404).send({
        ok: false,
        error: "Transaction not found",
        code: "transaction_not_found",
      });
    }
    // A pending transaction's TrxID is immutable once attached — overwriting
    // it could orphan the customer's real payment. Re-submitting the SAME
    // TrxID is an idempotent no-op (double-tap safety); a different one is 409.
    if (row.trx_id !== null) {
      if (row.trx_id === trxId) {
        return { ok: true, message: "TrxID already submitted. Awaiting operator approval." };
      }
      return reply.code(409).send({
        ok: false,
        error: "A different TrxID is already attached to this transaction",
        code: "trx_already_submitted",
      });
    }
    if (row.status !== "pending") {
      return reply.code(409).send({
        ok: false,
        error: `Transaction has already been ${row.status}`,
        code: "transaction_resolved",
      });
    }
    const approvedOwner = db
      .prepare(
        "SELECT 1 FROM credit_transactions WHERE trx_id = ? AND status = 'approved' LIMIT 1",
      )
      .get(trxId);
    if (approvedOwner !== undefined) {
      return reply.code(409).send({
        ok: false,
        error: "This TrxID has already been used and approved",
        code: "trx_id_already_approved",
      });
    }
    try {
      db.prepare(
        "UPDATE credit_transactions SET trx_id = ? WHERE id = ? AND status = 'pending'",
      ).run(trxId, transactionId);
    } catch (err) {
      // UNIQUE(partial index on trx_id): some other transaction holds it.
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({
          ok: false,
          error: "This TrxID is already attached to another transaction",
          code: "trx_id_exists",
        });
      }
      throw err;
    }
    app.log.info({ transactionId }, "trx submitted");
    return { ok: true, message: "TrxID submitted. Awaiting operator approval." };
  });

  // ── Operator/admin routes (requireOperator) ──────────────────────────────

  /** Create or update a package, keyed by packageCode (v4 upsertPackage). */
  app.post("/v5/admin/billing/packages", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = (asRecord(request.body) ?? {}) as UpsertPackageBody;
    const packageCode = asString(body.packageCode, 64);
    if (packageCode === null || !PACKAGE_CODE_PATTERN.test(packageCode)) {
      return reply.code(400).send({
        ok: false,
        error: "packageCode must be 2-64 chars of [A-Za-z0-9_-]",
        code: "invalid_package_code",
      });
    }
    const name = asString(body.name, 128);
    const smsQuota = body.smsQuota;
    const priceBdt = body.priceBdt;
    const validityDays = body.validityDays;
    const type = body.type;
    const isActive = body.isActive;
    if (
      name === null ||
      typeof smsQuota !== "number" || !Number.isInteger(smsQuota) || smsQuota < 1 ||
      typeof priceBdt !== "number" || !Number.isInteger(priceBdt) || priceBdt < 0 ||
      typeof validityDays !== "number" || !Number.isInteger(validityDays) || validityDays < 1 ||
      (type !== undefined && type !== "otp" && type !== "bulk" && type !== "both") ||
      (isActive !== undefined && typeof isActive !== "boolean")
    ) {
      return reply.code(400).send({
        ok: false,
        error: "name, smsQuota>=1, priceBdt>=0, validityDays>=1, type(otp|bulk|both), isActive required",
        code: "invalid_package",
      });
    }
    db.prepare(
      "INSERT INTO packages (id, package_code, name, sms_quota, price_bdt, validity_days, type, is_active, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()) " +
        "ON CONFLICT(package_code) DO UPDATE SET name = excluded.name, sms_quota = excluded.sms_quota, " +
        "price_bdt = excluded.price_bdt, validity_days = excluded.validity_days, type = excluded.type, " +
        "is_active = excluded.is_active, updated_at = excluded.updated_at",
    ).run(
      newId(),
      packageCode,
      name,
      smsQuota,
      priceBdt,
      validityDays,
      type ?? "otp",
      isActive === false ? 0 : 1,
    );
    app.log.info({ packageCode }, "package upserted");
    return reply.code(201).send({ ok: true, packageCode });
  });

  /**
   * Approve or reject a pending credit transaction (v4 approveCredit). The
   * award runs in ONE SQLite transaction that re-checks pending state — a
   * concurrent double-approve gets 409, never a double award. Expiry uses
   * v4 semantics: extend to max(current expiry, now + validity).
   */
  app.post("/v5/admin/billing/approve", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = (asRecord(request.body) ?? {}) as ApproveBody;
    const transactionId = asString(body.transactionId, 64);
    if (transactionId === null || typeof body.approve !== "boolean") {
      return reply.code(400).send({
        ok: false,
        error: "transactionId and approve (boolean) are required",
        code: "invalid_request",
      });
    }
    const trx = db
      .prepare("SELECT id, app_id, sms_quota, validity_days, package_type, status FROM credit_transactions WHERE id = ?")
      .get(transactionId) as
      | { id: string; app_id: string; sms_quota: number; validity_days: number; package_type: string; status: string }
      | undefined;
    if (!trx) {
      return reply.code(404).send({
        ok: false,
        error: "Transaction not found",
        code: "transaction_not_found",
      });
    }
    if (trx.status !== "pending") {
      return reply.code(409).send({
        ok: false,
        error: `Transaction already resolved with status: ${trx.status}`,
        code: "already_resolved",
      });
    }

    if (body.approve === false) {
      const reason = asString(body.rejectReason, 512);
      db.prepare(
        "UPDATE credit_transactions SET status = 'rejected', admin_notes = ?, resolved_by = 'operator', resolved_at = unixepoch() " +
          "WHERE id = ? AND status = 'pending'",
      ).run(reason, transactionId);
      app.log.info({ transactionId }, "credit rejected");
      return { ok: true, status: "rejected" };
    }

    // Approve + award atomically. Guard row: claiming the pending row is the
    // linearization point; two concurrent approvals cannot both claim it.
    const nowSec = Math.floor(Date.now() / 1000);
    const validitySec = trx.validity_days * 24 * 60 * 60;
    const newExpiry = nowSec + validitySec;

    const award = db.transaction(() => {
      const claimed = db
        .prepare(
          "UPDATE credit_transactions SET status = 'approved', resolved_by = 'operator', resolved_at = unixepoch() " +
            "WHERE id = ? AND status = 'pending'",
        )
        .run(transactionId);
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
        ).run(trx.app_id, trx.sms_quota, newExpiry, transactionId);
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
        ).run(trx.app_id, trx.sms_quota, newExpiry, transactionId);
      }
      return true;
    });

    if (!award()) {
      return reply.code(409).send({
        ok: false,
        error: "Transaction already resolved",
        code: "already_resolved",
      });
    }

    const credits = db
      .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM app_credits WHERE app_id = ?")
      .get(trx.app_id) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined;
    app.log.info({ transactionId, appId: trx.app_id }, "credit approved");
    return {
      ok: true,
      status: "approved",
      newOtpBalance: credits?.otp_sms_remaining ?? 0,
      newBulkBalance: credits?.bulk_sms_remaining ?? 0,
    };
  });

  /** Operator view: pending transactions queue (approval workflow input). */
  app.get("/v5/admin/billing/queue", { preHandler: [app.requireOperator] }, async () => {
    const rows = db
      .prepare(
        "SELECT id, app_id, package_code, sms_quota, amount_bdt, package_type, trx_id, requested_at " +
          "FROM credit_transactions WHERE status = 'pending' ORDER BY requested_at ASC",
      )
      .all() as {
      id: string;
      app_id: string;
      package_code: string;
      sms_quota: number;
      amount_bdt: number;
      package_type: string;
      trx_id: string | null;
      requested_at: number;
    }[];
    return {
      ok: true,
      pending: rows.map((t) => ({
        transactionId: t.id,
        appId: t.app_id,
        packageCode: t.package_code,
        smsQuota: t.sms_quota,
        amountBdt: t.amount_bdt,
        packageType: t.package_type,
        trxId: t.trx_id,
        requestedAt: t.requested_at,
      })),
    };
  });
};

export default billingRoutes;
