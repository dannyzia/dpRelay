/**
 * STAGE F5 (ISSUE-83) — reports plane. Two operator-only reports:
 * (a) per-customer credit ledger — package purchases, credits granted, and
 *     spend by type with timestamps (credit_transactions snapshots);
 * (b) item-wise send log — when, to whom (recipient), what (OTP session /
 *     bulk campaign), and status (pending_sms + source linkage).
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
   * Per-customer ledger: every credit transaction in the window (joins carry
   * app name + owner email for the "per-customer" dimension) plus spend
   * totals grouped by package type × status. `format=csv` streams the only
   * export form.
   */
  app.get("/v5/admin/reports/ledger", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const query = asRecord(request.query) ?? {};
    const { from, to } = window(query);
    const limit = queryInt(query.limit, 2000, 1, 10000);

    const rows = db
      .prepare(
        "SELECT ct.id, ct.app_id, a.name AS app_name, u.email AS owner_email, " +
          "ct.package_code, ct.package_type, ct.sms_quota, ct.amount_bdt, ct.status, ct.trx_id, " +
          "ct.requested_at, ct.resolved_at, ct.resolved_by " +
          "FROM credit_transactions ct " +
          "JOIN apps a ON a.id = ct.app_id " +
          "LEFT JOIN users u ON u.id = a.owner_user_id " +
          "WHERE ct.requested_at >= ? AND ct.requested_at <= ? " +
          "ORDER BY ct.requested_at DESC, ct.id ASC LIMIT ?",
      )
      .all(from, to, limit) as {
      id: string;
      app_id: string;
      app_name: string;
      owner_email: string | null;
      package_code: string;
      package_type: string;
      sms_quota: number;
      amount_bdt: number;
      status: string;
      trx_id: string | null;
      requested_at: number;
      resolved_at: number | null;
      resolved_by: string | null;
    }[];

    const totals = db
      .prepare(
        "SELECT package_type, status, COUNT(*) AS n, COALESCE(SUM(amount_bdt), 0) AS amount, " +
          "COALESCE(SUM(CASE WHEN status = 'approved' THEN sms_quota ELSE 0 END), 0) AS granted " +
          "FROM credit_transactions WHERE requested_at >= ? AND requested_at <= ? " +
          "GROUP BY package_type, status ORDER BY package_type, status",
      )
      .all(from, to) as {
      package_type: string;
      status: string;
      n: number;
      amount: number;
      granted: number;
    }[];

    const shaped = rows.map((r) => ({
      transactionId: r.id,
      appId: r.app_id,
      appName: r.app_name,
      ownerEmail: r.owner_email,
      packageCode: r.package_code,
      packageType: r.package_type,
      smsQuota: r.sms_quota,
      amountBdt: r.amount_bdt,
      status: r.status,
      trxId: r.trx_id,
      requestedAt: r.requested_at,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
    }));

    if (asString(query.format, 10) === "csv") {
      const csv = toCsv(
        [
          "transactionId",
          "appId",
          "appName",
          "ownerEmail",
          "packageCode",
          "packageType",
          "smsQuota",
          "amountBdt",
          "status",
          "trxId",
          "requestedAt",
          "resolvedAt",
          "resolvedBy",
        ],
        shaped.map((r) => [
          r.transactionId,
          r.appId,
          r.appName,
          r.ownerEmail,
          r.packageCode,
          r.packageType,
          r.smsQuota,
          r.amountBdt,
          r.status,
          r.trxId,
          iso(r.requestedAt),
          r.resolvedAt === null ? null : iso(r.resolvedAt),
          r.resolvedBy,
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
      rows: shaped,
      totals: totals.map((t) => ({
        packageType: t.package_type,
        status: t.status,
        count: t.n,
        amountBdt: t.amount,
        grantedSms: t.granted,
      })),
    };
  });

  /**
   * Item-wise send log: one row per queued message with recipient (PII —
   * operator-only), status/error, and its source reference (OTP session id
   * or bulk campaign id via the linkage columns). Scalar subqueries keep the
   * result strictly 1:1 regardless of linkage shape.
   */
  app.get("/v5/admin/reports/send-log", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const query = asRecord(request.query) ?? {};
    const { from, to } = window(query);
    const limit = queryInt(query.limit, 1000, 1, 10000);
    const appId = asString(query.appId, 64);

    const filters = ["ps.created_at >= ?", "ps.created_at <= ?"];
    const params: (string | number)[] = [from, to];
    if (appId !== null) {
      filters.push("ps.app_id = ?");
      params.push(appId);
    }
    params.push(limit);

    const rows = db
      .prepare(
        "SELECT ps.id, ps.app_id, a.name AS app_name, ps.to_addr, ps.status, ps.error, " +
          "ps.created_at, ps.result_at, " +
          "(SELECT os.id FROM otp_sessions os WHERE os.message_id = ps.id LIMIT 1) AS otp_session_id, " +
          "(SELECT br.campaign_id FROM bulk_recipients br WHERE br.pending_sms_id = ps.id LIMIT 1) AS bulk_campaign_id " +
          "FROM pending_sms ps " +
          // pending_sms.app_id holds the PUBLIC app id (otp.ts writes
          // appRow.appId, the bulk enqueue writes campaign.public_app_id) —
          // join on apps.app_id, not the internal UUID.
          "LEFT JOIN apps a ON a.app_id = ps.app_id " +
          `WHERE ${filters.join(" AND ")} ` +
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
      bulk_campaign_id: string | null;
    }[];

    const shaped = rows.map((r) => ({
      messageId: r.id,
      appId: r.app_id,
      appName: r.app_name,
      recipient: r.to_addr,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      resultAt: r.result_at,
      source: r.otp_session_id !== null ? "otp" : r.bulk_campaign_id !== null ? "bulk" : "other",
      sourceId: r.otp_session_id ?? r.bulk_campaign_id,
    }));

    if (asString(query.format, 10) === "csv") {
      const csv = toCsv(
        [
          "createdAt",
          "resultAt",
          "status",
          "source",
          "sourceId",
          "appId",
          "appName",
          "recipient",
          "error",
        ],
        shaped.map((r) => [
          iso(r.createdAt),
          r.resultAt === null ? null : iso(r.resultAt),
          r.status,
          r.source,
          r.sourceId,
          r.appId,
          r.appName,
          r.recipient,
          r.error,
        ]),
      );
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="send-log-${from}-${to}.csv"`)
        .send(csv);
    }

    return { ok: true, from, to, rows: shaped };
  });
};

export default adminReportRoutes;
