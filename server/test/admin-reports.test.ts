/**
 * STAGE F5 (ISSUE-83): reports.
 * Ordered invariants: per-customer ledger (purchases, grants, spend by type,
 * timestamps) and item-wise send log (when/who/what/status) are operator-only
 * (requireOperator on every route — recipient numbers are PII), CSV is the
 * only export (format=csv → attachment), and send-log rows classify their
 * source (otp session / bulk campaign / other) from the linkage columns.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const TEST_JWT_SECRET = "reports-test-jwt-0123456789abcdef0123456789abcdef";
const OPERATOR = "reports-operator-secret-0123456789abcdef";

let app: FastifyInstance;
let appAId: string; // apps.id owned by the seeded user
let appBId: string; // operator-provisioned app
const NOW = Math.floor(Date.now() / 1000);

function seedPackage(code: string, type: string): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO packages (id, package_code, name, sms_quota, price_bdt, validity_days, type, is_active, created_at, updated_at) " +
        "VALUES (?, ?, ?, 100, 200, 30, ?, 1, unixepoch(), unixepoch())",
    )
    .run(id, code, code, type);
  return id;
}

function seedTransaction(
  pkgId: string,
  code: string,
  appId: string,
  status: string,
  requestedAt: number,
  resolvedAt: number | null,
): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO credit_transactions (id, app_id, package_id, package_code, sms_quota, validity_days, " +
        "amount_bdt, package_type, status, requested_at, resolved_at, resolved_by) " +
        "VALUES (?, ?, ?, ?, 100, 30, 200, 'otp', ?, ?, ?, ?)",
    )
    .run(id, appId, pkgId, code, status, requestedAt, resolvedAt, resolvedAt !== null ? "operator" : null);
  return id;
}

function op(method: "GET", url: string) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${OPERATOR}` } });
}

beforeEach(() => {
  app = buildApp({
    dbPath: join(mkdtempSync(join(tmpdir(), "dprelay-reports-test-")), "test.db"),
    env: { JWT_SECRET: TEST_JWT_SECRET, OPERATOR_SECRET: OPERATOR },
  });

  // Customer user + owned app.
  const userId = crypto.randomUUID();
  app.db
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, unixepoch())")
    .run(userId, "ledger-cust@example.test", "scrypt:test-hash");
  appAId = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())",
    )
    .run(appAId, "app_owned", "hash-owned", "owned-app", userId);
  appBId = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(appBId, "app_op", "hash-op", "operator-app");

  // Ledger rows: in-window approved, in-window pending, out-of-window old.
  const pkg = seedPackage("otp100", "otp");
  seedTransaction(pkg, "otp100", appAId, "approved", NOW - 5 * 86400, NOW - 4 * 86400);
  seedTransaction(pkg, "otp100", appAId, "pending", NOW - 86400, null);
  seedTransaction(pkg, "otp100", appBId, "approved", NOW - 40 * 86400, NOW - 39 * 86400);

  // Send log: otp-linked, bulk-linked, unlinked.
  app.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at, result_at) " +
        "VALUES ('m1', 'app_owned', '+8801711111111', 'Your dP Relay verification code is 123456.', 'sent', ?, ?)",
    )
    .run(NOW - 100, NOW - 50);
  app.db
    .prepare(
      "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, expires_at, status, message_id, created_at) " +
        "VALUES ('s1', ?, '+8801711111111', 'hash', 'salt', ?, 'verified', 'm1', ?)",
    )
    .run(appAId, NOW + 300, NOW - 100);
  app.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, error, created_at) " +
        "VALUES ('m2', 'app_owned', '+8801712222222', 'Campaign hello', 'failed', 'carrier_rejected', ?)",
    )
    .run(NOW - 200);
  app.db
    .prepare(
      "INSERT INTO bulk_campaigns (id, app_id, name, message, total_recipients, created_at) " +
        "VALUES ('c1', ?, 'campaign-1', 'Campaign hello', 1, ?)",
    )
    .run(appAId, NOW - 300);
  app.db
    .prepare(
      "INSERT INTO bulk_recipients (id, campaign_id, phone, idx, status, pending_sms_id) " +
        "VALUES ('r1', 'c1', '+8801712222222', 0, 'failed', 'm2')",
    )
    .run();
  app.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
        "VALUES ('m3', 'app_op', '+8801713333333', 'Something else', 'pending', ?)",
    )
    .run(NOW - 300);
});

afterEach(async () => {
  await app.close();
});

describe("GET /v5/admin/reports/ledger", () => {
  it("returns in-window rows with customer identity and spend totals by type/status", async () => {
    const res = await op("GET", "/v5/admin/reports/ledger");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: { transactionId: string; ownerEmail: string | null; status: string; requestedAt: number }[];
      totals: { packageType: string; status: string; count: number; amountBdt: number; grantedSms: number }[];
    };
    // Default window = last 30 days: the 40-day-old row is excluded.
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r) => NOW - r.requestedAt <= 30 * 86400 + 60)).toBe(true);
    const owned = body.rows.find((r) => r.ownerEmail !== null);
    expect(owned?.ownerEmail).toBe("ledger-cust@example.test");

    expect(body.totals).toContainEqual({
      packageType: "otp",
      status: "approved",
      count: 1,
      amountBdt: 200,
      grantedSms: 100,
    });
    expect(body.totals).toContainEqual({
      packageType: "otp",
      status: "pending",
      count: 1,
      amountBdt: 200,
      grantedSms: 0,
    });
  });

  it("honors an explicit from/to window", async () => {
    const from = NOW - 6 * 86400;
    const res = await op("GET", `/v5/admin/reports/ledger?from=${from}`);
    const body = res.json() as { rows: { requestedAt: number }[] };
    expect(body.rows).toHaveLength(2); // pending (1d) + approved (5d); 40d row excluded
    expect(body.rows.every((r) => r.requestedAt >= from)).toBe(true);
  });

  it("streams CSV as the export form (attachment), keeping the operator gate", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/v5/admin/reports/ledger" });
    expect(noAuth.statusCode).toBe(401);

    const res = await op("GET", "/v5/admin/reports/ledger?format=csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="ledger-\d+-\d+\.csv"$/);
    const text = res.body;
    const header = text.split("\r\n")[0];
    expect(header).toBe(
      "transactionId,appId,appName,ownerEmail,packageCode,packageType,smsQuota,amountBdt,status,trxId,requestedAt,resolvedAt,resolvedBy",
    );
    expect(text).toContain("ledger-cust@example.test");
    expect(text).toContain("otp100");
    // Timestamps are ISO-8601 in the human export.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    // The out-of-window row never leaks into the default export (2 data rows).
    expect(text.match(/otp100/g)).toHaveLength(2);
  });
});

describe("GET /v5/admin/reports/send-log", () => {
  it("classifies each item's source and keeps status/error/recipient", async () => {
    const res = await op("GET", "/v5/admin/reports/send-log");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: {
        messageId: string;
        recipient: string;
        status: string;
        error: string | null;
        source: string;
        sourceId: string | null;
        appName: string | null;
      }[];
    };
    expect(body.rows).toHaveLength(3);
    const byId = new Map(body.rows.map((r) => [r.messageId, r]));
    expect(byId.get("m1")).toMatchObject({
      recipient: "+8801711111111",
      status: "sent",
      source: "otp",
      sourceId: "s1",
      appName: "owned-app",
    });
    expect(byId.get("m2")).toMatchObject({
      status: "failed",
      error: "carrier_rejected",
      source: "bulk",
      sourceId: "c1",
    });
    expect(byId.get("m3")).toMatchObject({ source: "other", sourceId: null, appName: "operator-app" });
  });

  it("filters by appId", async () => {
    // The appId filter keys on the PUBLIC app_id string — resolve it first.
    const pub = app.db.prepare("SELECT app_id FROM apps WHERE id = ?").get(appAId) as { app_id: string };
    const filtered = await op("GET", `/v5/admin/reports/send-log?appId=${pub.app_id}`);
    expect(filtered.statusCode).toBe(200);
    const rows = (filtered.json() as { rows: { messageId: string }[] }).rows;
    expect(rows.map((r) => r.messageId).sort()).toEqual(["m1", "m2"]);
  });

  it("streams PII CSV with spreadsheet-formula guard, operator gate only", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/v5/admin/reports/send-log" });
    expect(noAuth.statusCode).toBe(401);

    const res = await op("GET", "/v5/admin/reports/send-log?format=csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="send-log-\d+-\d+\.csv"$/);
    const text = res.body;
    expect(text.split("\r\n")[0]).toBe(
      "createdAt,resultAt,status,source,sourceId,appId,appName,recipient,error",
    );
    // Recipient numbers are present (operator-only export) but formula-guarded:
    // a leading + would otherwise execute as a formula in spreadsheets.
    expect(text).toContain("'+8801711111111");
    expect(text).toContain("'+8801712222222");
    expect(text).toContain("carrier_rejected");
    expect(text).toContain("s1");
    expect(text).toContain("c1");
  });
});
