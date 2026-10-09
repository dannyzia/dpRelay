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
import { awardPendingTransaction, UNIT_PRICE_BDT } from "../services/credits.js";
import { requireSession } from "../services/session.js";

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
  /** F5 amendment (ISSUE-89): price currency — BDT | USD | EUR, default BDT. */
  currency?: unknown;
}

interface ApproveBody {
  transactionId?: unknown;
  approve?: unknown;
  rejectReason?: unknown;
  /**
   * F5 amendment (ISSUE-89): remittance reference note stored on approve —
   * the REQUIRED paper trail for manual non-BDT approvals (USD/EUR package
   * payments arriving as bKash BDT-equivalents are manual by design).
   */
  notes?: unknown;
}

/** F5 amendment (ISSUE-89): the package price-currency enum. */
const PACKAGE_CURRENCIES = new Set(["BDT", "USD", "EUR"]);

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
        "SELECT package_code, name, sms_quota, price_bdt, validity_days, type, currency " +
          "FROM packages WHERE is_active = 1",
      )
      .all() as {
      package_code: string;
      name: string;
      sms_quota: number;
      price_bdt: number;
      validity_days: number;
      type: string;
      currency: string;
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
        currency: r.currency,
      })),
    };
  });

  /**
   * Current credit balance for the authenticated app (v4 getCredits).
   * STAGE F9 (ISSUE-88): a company-backed app reports its OWNER'S wallet —
   * the balance its sends actually draw from (dual-path rule); operator-
   * legacy apps keep reporting app_credits unchanged.
   */
  app.get("/v5/billing/credits", { preHandler: [app.requireApp] }, async (request) => {
    const walletOwner = request.appRow?.walletOwnerId ?? null;
    const row =
      walletOwner === null
        ? (db
            .prepare(
              "SELECT otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, " +
                "last_transaction_id, purchased_at FROM app_credits WHERE app_id = ?",
            )
            .get(request.appRow?.id ?? "") as
            | {
                otp_sms_remaining: number;
                bulk_sms_remaining: number;
                otp_expires_at: number | null;
                bulk_expires_at: number | null;
                last_transaction_id: string | null;
                purchased_at: number | null;
              }
            | undefined)
        : (db
            .prepare(
              "SELECT otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, " +
                "last_transaction_id, purchased_at FROM user_credits WHERE user_id = ?",
            )
            .get(walletOwner) as
            | {
                otp_sms_remaining: number;
                bulk_sms_remaining: number;
                otp_expires_at: number | null;
                bulk_expires_at: number | null;
                last_transaction_id: string | null;
                purchased_at: number | null;
              }
            | undefined);
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

    // STAGE F9 (ISSUE-88): wallet-backed apps list their OWNER'S wallet
    // purchases (buys land on the wallet, not app_credits — an app-attributed
    // query would return nothing for every company app). Operator-legacy apps
    // keep the app-attributed query unchanged.
    const walletOwner = request.appRow?.walletOwnerId ?? null;
    const attrColumn = walletOwner === null ? "app_id" : "user_id";
    const attrValue = walletOwner === null ? appId : walletOwner;
    const rows = db
      .prepare(
        // ISSUE-89 currency display: LEFT JOIN packages supplies the price
        // unit (referenced packages cannot be hard-deleted, so it resolves);
        // COALESCE keeps legacy rows taka-denominated.
        "SELECT ct.id, ct.package_code, ct.sms_quota, ct.validity_days, ct.amount_bdt, ct.package_type, " +
          "ct.trx_id, ct.status, ct.admin_notes, ct.requested_at, ct.resolved_at, " +
          "COALESCE(p.currency, 'BDT') AS currency " +
          "FROM credit_transactions ct LEFT JOIN packages p ON p.id = ct.package_id " +
          `WHERE ct.${attrColumn} = ? ` +
          "AND (? IS NULL OR ct.status = ?) " +
          "AND (? IS NULL OR ct.requested_at < ? OR (ct.requested_at = ? AND ct.id > ?)) " +
          "ORDER BY ct.requested_at DESC, ct.id ASC LIMIT ?",
      )
      .all(
        attrValue,
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
      currency: string;
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
        currency: t.currency,
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
  app.post("/v5/billing/credits/request", async (request, reply) => {
    // STAGE F9 (ISSUE-88) dual auth: app credentials (API plane — legacy
    // operator apps AND company apps) OR the dashboard session cookie (wallet
    // buy). App creds win when both are present (API parity); requireApp
    // sends its own failure envelope and leaves appRow unset on failure.
    let sessionUserId: string | null = null;
    const headerAppId = request.headers["x-app-id"];
    if (typeof headerAppId === "string" && headerAppId.length > 0) {
      await app.requireApp(request, reply);
      if (!request.appRow) return reply;
    } else {
      const session = requireSession(app.db, request, reply);
      if (session === null) return reply;
      sessionUserId = session.user.id;
    }
    // Attribution (F9 wallet rule): session buys always land on the user's
    // wallet; app buys land on the wallet too when the app is company-backed
    // (its sends already draw from there — an app-attributed award would be
    // dead money), otherwise on app_credits exactly as before.
    const walletUserId = sessionUserId ?? request.appRow?.walletOwnerId ?? null;
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
        "(id, app_id, user_id, package_id, package_code, sms_quota, validity_days, amount_bdt, " +
        "package_type, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch())",
    ).run(
      transactionId,
      walletUserId === null ? request.appRow?.id ?? null : null,
      walletUserId,
      pkg.id,
      packageCode,
      pkg.sms_quota,
      pkg.validity_days,
      pkg.price_bdt,
      pkg.type,
    );
    app.log.info(
      { appId: request.appRow?.appId ?? null, userId: walletUserId, transactionId, packageCode },
      "credit requested",
    );
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
  app.post("/v5/billing/credits/submit-trx", async (request, reply) => {
    // STAGE F9 (ISSUE-88): same dual auth as credits/request — the dashboard
    // submits a wallet purchase's TrxID with its session; API consumers keep
    // the app-credential path.
    let sessionUserId: string | null = null;
    const headerAppId = request.headers["x-app-id"];
    if (typeof headerAppId === "string" && headerAppId.length > 0) {
      await app.requireApp(request, reply);
      if (!request.appRow) return reply;
    } else {
      const session = requireSession(app.db, request, reply);
      if (session === null) return reply;
      sessionUserId = session.user.id;
    }
    const callerUserId = sessionUserId ?? request.appRow?.walletOwnerId ?? null;
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
      .prepare("SELECT status, trx_id, app_id, user_id FROM credit_transactions WHERE id = ?")
      .get(transactionId) as
      | { status: string; trx_id: string | null; app_id: string | null; user_id: string | null }
      | undefined;
    // Ownership (F9): user-attributed rows need the same user behind the
    // credentials; app-attributed rows need the same app. Unknown id and
    // foreign row share ONE envelope — no transaction-id enumeration.
    const owns =
      row !== undefined &&
      (row.user_id !== null ? row.user_id === callerUserId : row.app_id === request.appRow?.id);
    if (!owns) {
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
    const currency = body.currency === undefined ? "BDT" : body.currency;
    if (
      name === null ||
      typeof smsQuota !== "number" || !Number.isInteger(smsQuota) || smsQuota < 1 ||
      typeof priceBdt !== "number" || !Number.isInteger(priceBdt) || priceBdt < 0 ||
      typeof validityDays !== "number" || !Number.isInteger(validityDays) || validityDays < 1 ||
      (type !== undefined && type !== "otp" && type !== "bulk" && type !== "both") ||
      (isActive !== undefined && typeof isActive !== "boolean") ||
      typeof currency !== "string" || !PACKAGE_CURRENCIES.has(currency)
    ) {
      return reply.code(400).send({
        ok: false,
        error: "name, smsQuota>=1, priceBdt>=0, validityDays>=1, type(otp|bulk|both), isActive, currency(BDT|USD|EUR) required",
        code: "invalid_package",
      });
    }
    db.prepare(
      "INSERT INTO packages (id, package_code, name, sms_quota, price_bdt, validity_days, type, is_active, currency, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()) " +
        "ON CONFLICT(package_code) DO UPDATE SET name = excluded.name, sms_quota = excluded.sms_quota, " +
        "price_bdt = excluded.price_bdt, validity_days = excluded.validity_days, type = excluded.type, " +
        "is_active = excluded.is_active, currency = excluded.currency, updated_at = excluded.updated_at",
    ).run(
      newId(),
      packageCode,
      name,
      smsQuota,
      priceBdt,
      validityDays,
      type ?? "otp",
      isActive === false ? 0 : 1,
      currency,
    );
    app.log.info({ packageCode }, "package upserted");
    return reply.code(201).send({ ok: true, packageCode });
  });

  /**
   * STAGE F5 (ISSUE-83): partial package edit keyed by :code. Only whitelisted
   * fields are updatable (packageCode itself never — it is the stable public
   * identifier). Past transactions are unaffected either way: they carry their
   * own request-time snapshot columns (migration 006 note 1).
   */
  app.patch("/v5/admin/billing/packages/:code", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const packageCode = asString(params.code, 64);
    if (packageCode === null || !PACKAGE_CODE_PATTERN.test(packageCode)) {
      return reply.code(400).send({
        ok: false,
        error: "package code must be 2-64 chars of [A-Za-z0-9_-]",
        code: "invalid_package_code",
      });
    }
    const body = (asRecord(request.body) ?? {}) as UpsertPackageBody;

    // Each branch validates before appending — `sets` can only ever contain
    // literal column names, so the dynamic SET clause stays injection-free.
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (body.name !== undefined) {
      const name = asString(body.name, 128);
      if (name === null) return reject400(reply, "invalid_package", "name must be 1-128 chars");
      sets.push("name = ?");
      values.push(name);
    }
    if (body.smsQuota !== undefined) {
      const q = body.smsQuota;
      if (typeof q !== "number" || !Number.isInteger(q) || q < 1) return reject400(reply, "invalid_package", "smsQuota must be an integer >= 1");
      sets.push("sms_quota = ?");
      values.push(q);
    }
    if (body.priceBdt !== undefined) {
      const p = body.priceBdt;
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0) return reject400(reply, "invalid_package", "priceBdt must be an integer >= 0");
      sets.push("price_bdt = ?");
      values.push(p);
    }
    if (body.validityDays !== undefined) {
      const v = body.validityDays;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return reject400(reply, "invalid_package", "validityDays must be an integer >= 1");
      sets.push("validity_days = ?");
      values.push(v);
    }
    if (body.type !== undefined) {
      if (body.type !== "otp" && body.type !== "bulk" && body.type !== "both") {
        return reject400(reply, "invalid_package", "type must be otp|bulk|both");
      }
      sets.push("type = ?");
      values.push(body.type);
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") return reject400(reply, "invalid_package", "isActive must be a boolean");
      sets.push("is_active = ?");
      values.push(body.isActive ? 1 : 0);
    }
    if (body.currency !== undefined) {
      if (typeof body.currency !== "string" || !PACKAGE_CURRENCIES.has(body.currency)) {
        return reject400(reply, "invalid_package", "currency must be BDT|USD|EUR");
      }
      sets.push("currency = ?");
      values.push(body.currency);
    }
    if (sets.length === 0) {
      return reject400(reply, "invalid_package", "at least one of name, smsQuota, priceBdt, validityDays, type, isActive, currency is required");
    }
    const exists = db.prepare("SELECT 1 FROM packages WHERE package_code = ?").get(packageCode);
    if (!exists) {
      return reply.code(404).send({ ok: false, error: "Package not found", code: "package_not_found" });
    }
    sets.push("updated_at = unixepoch()");
    db.prepare(`UPDATE packages SET ${sets.join(", ")} WHERE package_code = ?`).run(...values, packageCode);
    app.log.info({ packageCode }, "package updated");
    return { ok: true, packageCode };
  });

  /**
   * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 spec): retire a package. Hard-delete
   * is FORBIDDEN — every credit_transactions row references its package
   * forever (audit history), so retire always soft-retires (is_active = 0)
   * regardless of references. A second retire is an idempotent no-op;
   * reactivation goes through PATCH/upsert (isActive). The spec names the
   * POST …/retire endpoint; DELETE became the RATIFIED safe-delete
   * (F5 amendment ISSUE-89, hub event 1319) — hard-delete only when the
   * package has zero transaction history, 409 package_in_use otherwise.
   */
  async function retireByCode(
    request: { params: unknown },
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const params = (request.params ?? {}) as { code?: unknown };
    const packageCode = asString(params.code, 64);
    if (packageCode === null || !PACKAGE_CODE_PATTERN.test(packageCode)) {
      return reply.code(400).send({
        ok: false,
        error: "package code must be 2-64 chars of [A-Za-z0-9_-]",
        code: "invalid_package_code",
      });
    }
    const row = db
      .prepare("SELECT is_active FROM packages WHERE package_code = ?")
      .get(packageCode) as { is_active: number } | undefined;
    if (!row) {
      return reply.code(404).send({ ok: false, error: "Package not found", code: "package_not_found" });
    }
    db.prepare(
      "UPDATE packages SET is_active = 0, updated_at = unixepoch() WHERE package_code = ? AND is_active != 0",
    ).run(packageCode);
    app.log.info({ packageCode }, "package retired");
    return reply.send({ ok: true, packageCode, isActive: false });
  }

  app.post(
    "/v5/admin/billing/packages/:code/retire",
    { preHandler: [app.requireOperator] },
    async (request, reply) => retireByCode(request, reply),
  );

  /**
   * STAGE F5 → F5 amendment (ISSUE-89, RATIFIED hub event 1319): SAFE DELETE.
   * A package with zero transaction history hard-deletes cleanly; anything a
   * transaction references (financial history) answers 409 package_in_use and
   * is retire-only permanently (POST …/retire above — unchanged, idempotent).
   * The pre-check also keeps the FK from throwing: credit_transactions has
   * NO ACTION on package_id, so an unguarded DELETE of a referenced package
   * would 500 instead of the structured 409 the operator UI renders.
   */
  app.delete("/v5/admin/billing/packages/:code", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const packageCode = asString(params.code, 64);
    if (packageCode === null || !PACKAGE_CODE_PATTERN.test(packageCode)) {
      return reply.code(400).send({
        ok: false,
        error: "package code must be 2-64 chars of [A-Za-z0-9_-]",
        code: "invalid_package_code",
      });
    }
    const pkg = db.prepare("SELECT id FROM packages WHERE package_code = ?").get(packageCode) as
      | { id: string }
      | undefined;
    if (!pkg) {
      return reply.code(404).send({ ok: false, error: "Package not found", code: "package_not_found" });
    }
    const refs = db
      .prepare(
        "SELECT COUNT(*) AS n FROM credit_transactions WHERE package_id = ? OR package_code = ?",
      )
      .get(pkg.id, packageCode) as { n: number };
    if (refs.n > 0) {
      return reply.code(409).send({
        ok: false,
        error: "Package has transaction history — retire it instead (soft retire is permanent)",
        code: "package_in_use",
      });
    }
    db.prepare("DELETE FROM packages WHERE package_code = ?").run(packageCode);
    app.log.info({ packageCode }, "package hard-deleted (zero transaction history)");
    return reply.send({ ok: true, packageCode, deleted: true });
  });

  /**
   * STAGE F5 (ISSUE-83): full package directory for the panel — unlike the
   * public catalog it includes RETIRED rows (is_active = 0), otherwise the
   * panel could never show or reactivate what DELETE retired.
   */
  app.get("/v5/admin/billing/packages", { preHandler: [app.requireOperator] }, async () => {
    const rows = db
      .prepare(
        "SELECT package_code, name, sms_quota, price_bdt, validity_days, type, is_active, currency, updated_at " +
          "FROM packages ORDER BY package_code",
      )
      .all() as {
      package_code: string;
      name: string;
      sms_quota: number;
      price_bdt: number;
      validity_days: number;
      type: string;
      is_active: number;
      currency: string;
      updated_at: number;
    }[];
    return {
      ok: true,
      packages: rows.map((r) => ({
        packageCode: r.package_code,
        name: r.name,
        smsQuota: r.sms_quota,
        priceBdt: r.price_bdt,
        validityDays: r.validity_days,
        type: r.type,
        isActive: r.is_active === 1,
        currency: r.currency,
        updatedAt: r.updated_at,
      })),
    };
  });

  /**
   * Pricing-conformance report (Stage E order): flags every package whose
   * price_bdt does not equal sms_quota × 0.20 — the owner's unit price
   * (decision Sep 27). REPORT ONLY: violations are surfaced, never silently
   * repriced; fixing a row is an operator decision through the upsert route.
   *
   * F5 amendment (ISSUE-89): the 0.20 figure is a BDT unit price — non-BDT
   * packages are regional prices and are EXCLUDED (counted, not judged),
   * otherwise every USD/EUR row would "violate" a currency it is not in.
   *
   * The 1e-9 epsilon absorbs double rounding on `sms_quota * 0.20` (0.2 is not
   * exactly representable); anything a human would call a pricing mismatch is
   * orders of magnitude larger than that.
   */
  app.get(
    "/v5/admin/billing/pricing-conformance",
    { preHandler: [app.requireOperator] },
    async () => {
      const rows = db
        .prepare(
          "SELECT package_code, name, sms_quota, price_bdt, is_active, currency FROM packages ORDER BY package_code",
        )
        .all() as {
        package_code: string;
        name: string;
        sms_quota: number;
        price_bdt: number;
        is_active: number;
        currency: string;
      }[];
      const bdtRows = rows.filter((r) => r.currency === "BDT");
      const violations = bdtRows
        .map((r) => ({
          packageCode: r.package_code,
          name: r.name,
          smsQuota: r.sms_quota,
          priceBdt: r.price_bdt,
          expectedPriceBdt: r.sms_quota * UNIT_PRICE_BDT,
          deltaBdt: r.price_bdt - r.sms_quota * UNIT_PRICE_BDT,
          isActive: r.is_active === 1,
          conformant: Math.abs(r.price_bdt - r.sms_quota * UNIT_PRICE_BDT) < 1e-9,
        }))
        .filter((p) => !p.conformant);
      return {
        ok: true,
        unitPriceBdt: UNIT_PRICE_BDT,
        packageCount: rows.length,
        excludedNonBdtCount: rows.length - bdtRows.length,
        conformantCount: bdtRows.length - violations.length,
        violationCount: violations.length,
        violations,
      };
    },
  );

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
      .prepare("SELECT id, app_id, user_id, sms_quota, validity_days, package_type, status FROM credit_transactions WHERE id = ?")
      .get(transactionId) as
      | {
          id: string;
          app_id: string | null;
          user_id: string | null;
          sms_quota: number;
          validity_days: number;
          package_type: string;
          status: string;
        }
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

    // Approve + award atomically through the shared award core (F5 ISSUE-83:
    // the payment-attach path must mutate balances identically — two copies
    // of money code is how they drift). Claiming the pending row inside the
    // transaction is the linearization point; concurrent approvals race to a
    // 409, never to a double award.
    // F5 amendment (ISSUE-89): a remittance reference note rides the SAME
    // transaction as the award — written only while the row is still pending,
    // so a lost race can leave the note on a pending row (harmless, retryable)
    // but never overwrite a resolved row's audit trail. Non-BDT approvals
    // (USD/EUR packages, bKash BDT-equivalents) are manual by design and use
    // this note as their paper trail.
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 512) : null;
    const award = db.transaction(() => {
      if (notes !== null && notes !== "") {
        db.prepare(
          "UPDATE credit_transactions SET admin_notes = ? WHERE id = ? AND status = 'pending'",
        ).run(notes, transactionId);
      }
      return awardPendingTransaction(db, trx);
    });

    if (!award()) {
      return reply.code(409).send({
        ok: false,
        error: "Transaction already resolved",
        code: "already_resolved",
      });
    }

    // STAGE F9 (ISSUE-88): report the balance of the plane the award landed
    // on — user wallet (user-attributed buys) or app bucket (legacy).
    const credits =
      trx.user_id !== null
        ? (db
            .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM user_credits WHERE user_id = ?")
            .get(trx.user_id) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined)
        : (db
            .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM app_credits WHERE app_id = ?")
            .get(trx.app_id) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined);
    app.log.info({ transactionId, appId: trx.app_id, userId: trx.user_id }, "credit approved");
    return {
      ok: true,
      status: "approved",
      newOtpBalance: credits?.otp_sms_remaining ?? 0,
      newBulkBalance: credits?.bulk_sms_remaining ?? 0,
    };
  });

  /** Operator view: pending transactions queue (approval workflow input). */
  app.get("/v5/admin/billing/queue", { preHandler: [app.requireOperator] }, async () => {
    // STAGE F9 (ISSUE-88): wallet purchases carry no app — the queue shows
    // the user attribution so the operator can tell a wallet buy from an app
    // buy (both still approve through the same award core).
    const rows = db
      .prepare(
        "SELECT ct.id, ct.app_id, ct.user_id, ct.package_code, ct.sms_quota, ct.amount_bdt, " +
          "ct.package_type, ct.trx_id, ct.requested_at, COALESCE(p.currency, 'BDT') AS currency " +
          "FROM credit_transactions ct LEFT JOIN packages p ON p.id = ct.package_id " +
          "WHERE ct.status = 'pending' ORDER BY ct.requested_at ASC",
      )
      .all() as {
      id: string;
      app_id: string | null;
      user_id: string | null;
      package_code: string;
      sms_quota: number;
      amount_bdt: number;
      package_type: string;
      trx_id: string | null;
      requested_at: number;
      currency: string;
    }[];
    return {
      ok: true,
      pending: rows.map((t) => ({
        transactionId: t.id,
        appId: t.app_id,
        userId: t.user_id,
        packageCode: t.package_code,
        smsQuota: t.sms_quota,
        amountBdt: t.amount_bdt,
        packageType: t.package_type,
        currency: t.currency,
        trxId: t.trx_id,
        requestedAt: t.requested_at,
      })),
    };
  });
};

export default billingRoutes;
