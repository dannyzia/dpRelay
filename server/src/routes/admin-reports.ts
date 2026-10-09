/**
 * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 prescriptive spec, hub event 1266) —
 * reports plane. Two operator-only reports:
 *
 * (a) Ledger (`GET /v5/admin/reports/ledger`) — rows exactly
 *     timestamp | app | kind | package | qty | amount-BDT | TrxID where kind
 *     classifies the credit movement:
 *       - purchase: APPROVED credit_transactions (settled money → granted
 *         credits; pending/rejected requests move nothing and live on the
 *         Payments/queue screens instead),
 *       - trial: app_credits.trial_granted_at snapshot (migration 015 —
 *         grants before 015 are genuinely unrecoverable, so no rows are
 *         fabricated for them),
 *       - spend-otp / spend-bulk: sent-message debits grouped per app per
 *         day (credits are decremented at enqueue in both planes), priced at
 *         the owner's UNIT_PRICE_BDT. Only linkage-evidenced rows count —
 *         an unlinked legacy pending_sms row is not attributed to a kind.
 *     Cursor-paginated (ts:id keyset), max 100 rows/page.
 *
 * (b) Send log (`GET /v5/admin/reports/sends`) — one row per message:
 *     timestamp | app | kind(otp|bulk) | recipient-E164 | ref(sessionId|
 *     campaignId) | status | campaign-name, cursor-paginated max 100/page.
 *     Derived status: failed → failed; session verified/expired → that;
 *     message sent → sent; in-flight (pending/claimed) → pending (additive
 *     fifth value — the spec's four are terminal outcomes, but hiding
 *     in-flight rows would make "what is happening right now" unanswerable;
 *     FLAGGED on the hub). kind 'other' marks legacy unlinked rows (real
 *     writers — otp.ts / bulk enqueue — always link).
 *
 * PRIVACY (hub event 1213): recipient numbers are PII. Both reports sit
 * behind requireOperator (OPERATOR_SECRET), appear on no customer route, and
 * the ONLY export is CSV (`?format=csv`, Content-Disposition: attachment) —
 * JSON exists solely to render the panel table on screen. CSV cells are
 * formula-guarded (leading =, +, -, @, tab) so a crafted recipient/error
 * value cannot execute when the operator opens the export in a spreadsheet;
 * cells that are plain numbers are left untouched.
 */
import type { FastifyPluginAsync } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { UNIT_PRICE_BDT } from "../services/credits.js";

/** Parses a query value as a clamped integer (string or number input). */
function queryInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Epoch SECONDS → ISO-8601 for human-facing CSV cells. */
function iso(epochSec: number | null): string {
  return epochSec === null ? "" : new Date(epochSec * 1000).toISOString();
}

/**
 * CSV cell: formula-guard first (spreadsheet injection), then quote per
 * RFC 4180 when the value contains quotes/commas/newlines.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  const guarded = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Builds a CSV document (CRLF line endings per RFC 4180). */
function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const lines = [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/** One merged ledger row before pagination. */
interface LedgerRow {
  /** Sort/cursor identity: `ct.id` | `trial:<app_id>` | `<app>:<kind>:<day>`. */
  id: string;
  timestamp: number;
  appId: string;
  appName: string | null;
  ownerEmail: string | null;
  kind: "purchase" | "trial" | "spend-otp" | "spend-bulk";
  packageCode: string;
  qty: number;
  amountBdt: number;
  /**
   * ISSUE-89: the amount's unit. Purchases carry the package's price
   * currency; trial grants and spend rows are internal taka-denominated
   * accounting (qty × UNIT_PRICE_BDT), so they are always BDT.
   */
  currency: string;
  trxId: string | null;
}

/** `ts:id` cursor → parts (null when malformed; caller starts at page 1). */
function parseCursor(raw: unknown): { ts: number; id: string } | null {
  if (typeof raw !== "string" || raw === "") return null;
  const sep = raw.indexOf(":");
  const ts = sep > 0 ? Number.parseInt(raw.slice(0, sep), 10) : NaN;
  const id = sep > 0 ? raw.slice(sep + 1) : "";
  return Number.isInteger(ts) && ts >= 0 && id.length > 0 ? { ts, id } : null;
}

const adminReportRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /** Shared from/to window parsing: default last 30 days, bounded by caller. */
  function window(query: Record<string, unknown>): { from: number; to: number } {
    const now = Math.floor(Date.now() / 1000);
    const to = queryInt(query.to, now, 0, now + 31536000);
    const from = queryInt(query.from, to - 30 * 24 * 60 * 60, 0, to);
    return { from, to };
  }

  /**
   * Per-customer ledger (spec columns + additive identity fields for the
   * screen: appId/appName/ownerEmail — CSV stays exactly the spec's seven).
   * Sources are fetched window-bounded (default 30 days), merged by
   * (timestamp DESC, id ASC), then cursor-paginated in JS — the heterogeneous
   * id spaces make one UNION SQL strictly worse than a merge of three bounded
   * result sets, and the window is the memory bound.
   */
  app.get("/v5/admin/reports/ledger", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const query = asRecord(request.query) ?? {};
    const { from, to } = window(query);
    // CSV export = the whole window (cursor paging is a screen concern);
    // JSON = one 100-row page behind the keyset cursor.
    const exportMode = asString(query.format, 10) === "csv";
    const limit = exportMode ? Number.MAX_SAFE_INTEGER : queryInt(query.limit, 100, 1, 100);
    const appId = asString(query.appId, 64);
    const cursor = exportMode ? null : parseCursor(query.cursor);
    const appClause = appId !== null ? " AND a.app_id = ?" : "";
    const appParam = appId !== null ? [appId] : [];

    // 1) Purchases: settled money (approved only — see file header).
    // STAGE F9 (ISSUE-88) fallout fix: wallet purchases carry NO app
    // (credit_transactions.user_id set, app_id NULL) — LEFT JOIN keeps them,
    // and the owner identity resolves through the attribution column first.
    // Wallet rows render as appId "wallet" (CSV/JSON stay honest: no app sold it).
    const purchases = db
      .prepare(
        "SELECT ct.id, ct.resolved_at AS ts, a.app_id, a.name AS app_name, u.email AS owner_email, " +
          "ct.package_code, ct.sms_quota AS qty, ct.amount_bdt, ct.trx_id, COALESCE(p.currency, 'BDT') AS currency " +
          "FROM credit_transactions ct " +
          "LEFT JOIN apps a ON a.id = ct.app_id " +
          "LEFT JOIN packages p ON p.id = ct.package_id " +
          "LEFT JOIN users u ON u.id = COALESCE(ct.user_id, a.owner_user_id) " +
          "WHERE ct.status = 'approved' AND ct.resolved_at IS NOT NULL " +
          "AND ct.resolved_at >= ? AND ct.resolved_at <= ?" +
          appClause +
          " ORDER BY ct.resolved_at DESC, ct.id ASC",
      )
      .all(from, to, ...appParam) as {
      id: string;
      ts: number;
      app_id: string | null;
      app_name: string | null;
      owner_email: string | null;
      package_code: string;
      qty: number;
      amount_bdt: number;
      trx_id: string | null;
      currency: string;
    }[];

    // 2) Trial grants: the migration-015 snapshot (going forward).
    const trials = db
      .prepare(
        "SELECT a.app_id, ac.trial_sms_granted AS qty, ac.trial_granted_at AS ts, " +
          "a.name AS app_name, u.email AS owner_email " +
          "FROM app_credits ac " +
          "JOIN apps a ON a.id = ac.app_id " +
          "LEFT JOIN users u ON u.id = a.owner_user_id " +
          "WHERE ac.trial_granted_at IS NOT NULL AND ac.trial_granted_at >= ? AND ac.trial_granted_at <= ?" +
          appClause +
          " ORDER BY ac.trial_granted_at DESC, a.app_id ASC",
      )
      .all(from, to, ...appParam) as {
      app_id: string;
      qty: number | null;
      ts: number;
      app_name: string;
      owner_email: string | null;
    }[];

    // 3) Spend: one row per app per UTC day per kind (credits are debited
    //    at enqueue in both planes). Linkage evidence required (file header).
    const spends = db
      .prepare(
        "SELECT ps.app_id, (ps.created_at / 86400) * 86400 AS ts, a.name AS app_name, " +
          "CASE WHEN EXISTS (SELECT 1 FROM bulk_recipients br WHERE br.pending_sms_id = ps.id) " +
          "THEN 'spend-bulk' ELSE 'spend-otp' END AS kind, COUNT(*) AS qty " +
          "FROM pending_sms ps " +
          "JOIN apps a ON a.app_id = ps.app_id " +
          "WHERE ps.created_at >= ? AND ps.created_at <= ? " +
          "AND (EXISTS (SELECT 1 FROM otp_sessions os WHERE os.message_id = ps.id) " +
          "     OR EXISTS (SELECT 1 FROM bulk_recipients br WHERE br.pending_sms_id = ps.id))" +
          appClause +
          " GROUP BY ps.app_id, ts, kind ORDER BY ts DESC, ps.app_id ASC",
      )
      .all(from, to, ...appParam) as {
      app_id: string;
      ts: number;
      app_name: string;
      kind: "spend-otp" | "spend-bulk";
      qty: number;
    }[];

    const rows: LedgerRow[] = [
      ...purchases.map((r) => ({
        id: r.id,
        timestamp: r.ts,
        appId: r.app_id ?? "wallet",
        appName: r.app_name,
        ownerEmail: r.owner_email,
        kind: "purchase" as const,
        packageCode: r.package_code,
        qty: r.qty,
        amountBdt: r.amount_bdt,
        currency: r.currency,
        trxId: r.trx_id,
      })),
      ...trials.map((r) => ({
        id: `trial:${r.app_id}`,
        timestamp: r.ts,
        appId: r.app_id,
        appName: r.app_name,
        ownerEmail: r.owner_email,
        kind: "trial" as const,
        packageCode: "trial",
        qty: r.qty ?? 0,
        amountBdt: 0,
        currency: "BDT",
        trxId: null,
      })),
      ...spends.map((r) => ({
        id: `${r.app_id}:${r.kind}:${r.ts}`,
        timestamp: r.ts,
        appId: r.app_id,
        appName: r.app_name,
        ownerEmail: null,
        kind: r.kind,
        packageCode: "",
        qty: r.qty,
        amountBdt: Math.round(r.qty * UNIT_PRICE_BDT * 100) / 100,
        currency: "BDT",
        trxId: null,
      })),
    ];
    // Strict (ts DESC, id ASC) — the same total order the cursor resumes by.
    rows.sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const after = rows.filter(
      (r) =>
        cursor === null ||
        r.timestamp < cursor.ts ||
        (r.timestamp === cursor.ts && r.id > cursor.id),
    );
    const page = after.slice(0, limit);
    const hasMore = after.length > limit;    const nextCursor = hasMore && page.length > 0
      ? `${page[page.length - 1]?.timestamp ?? 0}:${page[page.length - 1]?.id ?? ""}`
      : null;

    // Additive context line (unchanged semantics: request pipeline by status
    // for the window's REQUESTS, independent of the row pagination).
    const totals = db
      .prepare(
        // ISSUE-89: currency joins the GROUP BY so a USD total is never
        // summed into (or rendered as) taka — 1 USD ≠ 1 BDT.
        "SELECT ct.package_type, ct.status, COALESCE(p.currency, 'BDT') AS currency, " +
          "COUNT(*) AS n, COALESCE(SUM(ct.amount_bdt), 0) AS amount, " +
          "COALESCE(SUM(CASE WHEN ct.status = 'approved' THEN ct.sms_quota ELSE 0 END), 0) AS granted " +
          "FROM credit_transactions ct LEFT JOIN packages p ON p.id = ct.package_id " +
          "WHERE ct.requested_at >= ? AND ct.requested_at <= ? " +
          "GROUP BY ct.package_type, ct.status, currency ORDER BY ct.package_type, ct.status, currency",
      )
      .all(from, to) as {
      package_type: string;
      status: string;
      currency: string;
      n: number;
      amount: number;
      granted: number;
    }[];

    if (exportMode) {
      // Spec columns exactly: timestamp | app | kind | package | qty | amount-BDT | TrxID.
      const csv = toCsv(
        ["timestamp", "app", "kind", "package", "qty", "amountBdt", "trxId"],
        page.map((r) => [
          iso(r.timestamp),
          r.appName ?? r.appId,
          r.kind,
          r.packageCode,
          r.qty,
          r.amountBdt,
          r.trxId,
        ]),
      );
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="ledger-${from}-${to}.csv"`)
        .send(csv);
    }

    return {
      ok: true,
      from,
      to,
      rows: page,
      nextCursor,
      totals: totals.map((t) => ({
        packageType: t.package_type,
        status: t.status,
        currency: t.currency,
        count: t.n,
        amountBdt: t.amount,
        grantedSms: t.granted,
      })),
    };
  });

  /**
   * F5 amendment (ISSUE-89, hub event 1318): package-aggregate report —
   * per package: count sold, total amount, SMS sold, first/last sale inside
   * the window, each carrying the package's PRICE CURRENCY (the report is
   * currency-dimensioned: totals are rolled up per currency and NEVER summed
   * across currencies, since 1 USD ≠ 1 BDT). Approved purchases only (settled
   * money — ledger parity), read from the request-time snapshot columns so
   * later package edits cannot rewrite history. `?from=&to=` epoch seconds,
   * default last 30 days (shared window helper).
   */
  app.get("/v5/admin/reports/packages", { preHandler: [app.requireOperator] }, async (request) => {
    const query = asRecord(request.query) ?? {};
    const { from, to } = window(query);
    const rows = db
      .prepare(
        "SELECT ct.package_code, p.name, p.currency, COUNT(*) AS count_sold, " +
          "COALESCE(SUM(ct.amount_bdt), 0) AS total_amount, " +
          "COALESCE(SUM(ct.sms_quota), 0) AS sms_sold, " +
          "MIN(ct.resolved_at) AS first_sold_at, MAX(ct.resolved_at) AS last_sold_at " +
          "FROM credit_transactions ct JOIN packages p ON p.id = ct.package_id " +
          "WHERE ct.status = 'approved' AND ct.resolved_at IS NOT NULL " +
          "AND ct.resolved_at >= ? AND ct.resolved_at <= ? " +
          "GROUP BY ct.package_code, p.name, p.currency " +
          "ORDER BY p.currency, ct.package_code",
      )
      .all(from, to) as {
      package_code: string;
      name: string;
      currency: string;
      count_sold: number;
      total_amount: number;
      sms_sold: number;
      first_sold_at: number | null;
      last_sold_at: number | null;
    }[];

    // Currency rollup: one bucket per currency — sums stay unit-consistent.
    const rollup = new Map<string, { currency: string; countSold: number; totalAmount: number }>();
    for (const r of rows) {
      const acc = rollup.get(r.currency) ?? { currency: r.currency, countSold: 0, totalAmount: 0 };
      acc.countSold += r.count_sold;
      acc.totalAmount += r.total_amount;
      rollup.set(r.currency, acc);
    }

    return {
      ok: true,
      from,
      to,
      rows: rows.map((r) => ({
        packageCode: r.package_code,
        name: r.name,
        currency: r.currency,
        countSold: r.count_sold,
        totalAmount: r.total_amount,
        smsSold: r.sms_sold,
        firstSoldAt: r.first_sold_at,
        lastSoldAt: r.last_sold_at,
      })),
      totalsByCurrency: Array.from(rollup.values()).sort((a, b) => a.currency.localeCompare(b.currency)),
    };
  });

  /**
   * Item-wise send log (spec path /reports/sends — supersedes the
   * ISSUE-83 /reports/send-log path, branch-only): one row per queued
   * message with recipient (PII — operator-only), derived status, source ref
   * (OTP session id or bulk campaign id), and the campaign name for bulk.
   * Keyset cursor: (created_at DESC, id ASC), max 100 rows/page.
   */
  app.get("/v5/admin/reports/sends", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const query = asRecord(request.query) ?? {};
    const { from, to } = window(query);
    // CSV export = whole window (up to a hard 10 000-row safety bound);
    // JSON = one 100-row page behind the keyset cursor.
    const exportMode = asString(query.format, 10) === "csv";
    const limit = exportMode ? 10000 : queryInt(query.limit, 100, 1, 100);
    const appId = asString(query.appId, 64);
    const cursor = exportMode ? null : parseCursor(query.cursor);

    const clauses = ["ps.created_at >= ?", "ps.created_at <= ?"];
    const params: (string | number)[] = [from, to];
    if (appId !== null) {
      clauses.push("ps.app_id = ?");
      params.push(appId);
    }
    if (cursor !== null) {
      clauses.push("(ps.created_at < ? OR (ps.created_at = ? AND ps.id > ?))");
      params.push(cursor.ts, cursor.ts, cursor.id);
    }
    params.push(limit + 1);

    const rows = db
      .prepare(
        "SELECT ps.id, ps.app_id, a.name AS app_name, ps.to_addr, ps.status, ps.error, " +
          "ps.created_at, ps.result_at, " +
          "(SELECT os.id FROM otp_sessions os WHERE os.message_id = ps.id LIMIT 1) AS otp_session_id, " +
          "(SELECT os.status FROM otp_sessions os WHERE os.message_id = ps.id LIMIT 1) AS otp_status, " +
          "(SELECT br.campaign_id FROM bulk_recipients br WHERE br.pending_sms_id = ps.id LIMIT 1) AS bulk_campaign_id, " +
          "(SELECT bc.name FROM bulk_recipients br JOIN bulk_campaigns bc ON bc.id = br.campaign_id " +
          " WHERE br.pending_sms_id = ps.id LIMIT 1) AS campaign_name " +
          "FROM pending_sms ps " +
          // pending_sms.app_id holds the PUBLIC app id (otp.ts writes
          // appRow.appId, the bulk enqueue writes campaign.public_app_id) —
          // join on apps.app_id, not the internal UUID.
          "LEFT JOIN apps a ON a.app_id = ps.app_id " +
          `WHERE ${clauses.join(" AND ")} ` +
          "ORDER BY ps.created_at DESC, ps.id ASC LIMIT ?",
      )
      .all(...params) as {
      id: string;
      app_id: string | null;
      app_name: string | null;
      to_addr: string;
      status: string;
      error: string | null;
      created_at: number;
      result_at: number | null;
      otp_session_id: string | null;
      otp_status: string | null;
      bulk_campaign_id: string | null;
      campaign_name: string | null;
    }[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const shaped = page.map((r) => {
      const kind = r.bulk_campaign_id !== null ? "bulk" : r.otp_session_id !== null ? "otp" : "other";
      const status =
        r.status === "failed"
          ? "failed"
          : r.otp_status === "verified"
            ? "verified"
            : r.otp_status === "expired"
              ? "expired"
              : r.status === "sent"
                ? "sent"
                : "pending";
      return {
        timestamp: r.created_at,
        messageId: r.id,
        appId: r.app_id,
        appName: r.app_name,
        kind,
        recipient: r.to_addr,
        ref: r.otp_session_id ?? r.bulk_campaign_id,
        status,
        campaignName: r.campaign_name,
        error: r.error,
        resultAt: r.result_at,
      };
    });

    if (exportMode) {
      // Spec columns exactly: timestamp | app | kind | recipient | ref | status | campaign-name.
      const csv = toCsv(
        ["timestamp", "app", "kind", "recipient", "ref", "status", "campaignName"],
        shaped.map((r) => [
          iso(r.timestamp),
          r.appName ?? r.appId,
          r.kind,
          r.recipient,
          r.ref,
          r.status,
          r.campaignName,
        ]),
      );
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="send-log-${from}-${to}.csv"`)
        .send(csv);
    }

    const last = shaped[shaped.length - 1];
    return {
      ok: true,
      from,
      to,
      rows: shaped,
      nextCursor: hasMore && last !== undefined ? `${last.timestamp}:${last.messageId}` : null,
    };
  });
};

export default adminReportRoutes;
