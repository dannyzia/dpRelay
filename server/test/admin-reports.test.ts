/**
 * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 prescriptive spec): reports.
 * Ordered invariants: the ledger classifies every credit movement into the
 * spec's kinds (purchase | trial | spend-otp | spend-bulk) with the exact
 * spec columns, cursor-paginated max 100/page and filterable by appId +
 * date; the send log (spec path /reports/sends, supersedes ISSUE-83's
 * /reports/send-log) carries timestamp | app | kind | recipient | ref |
 * status | campaign-name with derived terminal status, same pagination +
 * filters; both are operator-only (requireOperator — recipient numbers are
 * PII), CSV is the ONLY export and carries exactly the spec columns with
 * spreadsheet-formula guarding.
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

  // Ledger sources: an in-window approved purchase, an in-window pending
  // (NOT a ledger row — pending moves nothing), a 40-day-old approved row
  // (outside the default window), and a trial grant snapshot.
  const pkg = seedPackage("otp100", "otp");
  seedTransaction(pkg, "otp100", appAId, "approved", NOW - 5 * 86400, NOW - 4 * 86400);
  seedTransaction(pkg, "otp100", appAId, "pending", NOW - 86400, null);
  seedTransaction(pkg, "otp100", appBId, "approved", NOW - 40 * 86400, NOW - 39 * 86400);
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, otp_sms_remaining, bulk_sms_remaining, trial_sms_granted, trial_granted_at, updated_at) " +
        "VALUES (?, 20, 20, 20, ?, unixepoch())",
    )
    .run(appAId, NOW - 3 * 86400);

  // Send log: otp-verified, bulk-failed (with campaign name), unlinked
  // legacy row, otp-sent (session pending), otp-expired.
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
  app.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
        "VALUES ('m4', 'app_op', '+8801714444444', 'Code 654321', 'sent', ?)",
    )
    .run(NOW - 400);
  app.db
    .prepare(
      "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, expires_at, status, message_id, created_at) " +
        "VALUES ('s4', ?, '+8801714444444', 'hash', 'salt', ?, 'pending', 'm4', ?)",
    )
    .run(appBId, NOW + 300, NOW - 400);
  app.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
        "VALUES ('m5', 'app_owned', '+8801715555555', 'Code 111222', 'sent', ?)",
    )
    .run(NOW - 500);
  app.db
    .prepare(
      "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, expires_at, status, message_id, created_at) " +
        "VALUES ('s5', ?, '+8801715555555', 'hash', 'salt', ?, 'expired', 'm5', ?)",
    )
    .run(appAId, NOW - 450, NOW - 500);
});

afterEach(async () => {
  await app.close();
});

describe("GET /v5/admin/reports/ledger (spec kinds + columns)", () => {
  it("classifies purchase / trial / spend rows with the spec columns and exact window", async () => {
    const res = await op("GET", "/v5/admin/reports/ledger");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: {
        timestamp: number;
        appId: string;
        appName: string | null;
        ownerEmail: string | null;
        kind: string;
        packageCode: string;
        qty: number;
        amountBdt: number;
        trxId: string | null;
      }[];
      nextCursor: string | null;
      totals: { packageType: string; status: string; count: number; amountBdt: number; grantedSms: number }[];
    };

    // 5 rows: 1 purchase + 1 trial + 3 spend groups. NOT present: the
    // pending transaction (moves nothing), the 40-day-old purchase (window),
    // and the unlinked m3 (no evidence → no fabricated attribution).
    expect(body.rows).toHaveLength(5);
    expect(body.nextCursor).toBeNull();

    const purchase = body.rows.find((r) => r.kind === "purchase");
    expect(purchase).toMatchObject({
      appId: "app_owned",
      appName: "owned-app",
      ownerEmail: "ledger-cust@example.test",
      packageCode: "otp100",
      qty: 100,
      amountBdt: 200,
      trxId: null,
    });
    expect(purchase?.timestamp).toBe(NOW - 4 * 86400);

    const trial = body.rows.find((r) => r.kind === "trial");
    expect(trial).toMatchObject({
      appId: "app_owned",
      kind: "trial",
      packageCode: "trial",
      qty: 20,
      amountBdt: 0,
      trxId: null,
    });

    const spends = body.rows.filter((r) => r.kind.startsWith("spend-"));
    expect(spends).toHaveLength(3);
    const ownedBulk = spends.find((r) => r.kind === "spend-bulk");
    expect(ownedBulk).toMatchObject({ appId: "app_owned", qty: 1, amountBdt: 0.2, packageCode: "" });
    const ownedOtp = spends.find((r) => r.kind === "spend-otp" && r.appId === "app_owned");
    // m1 + m5 are both app_owned OTP sends on the same UTC day → one group.
    expect(ownedOtp).toMatchObject({ qty: 2, amountBdt: 0.4 });
    // app_op spend comes ONLY from m4 (m3 is unlinked and never attributed).
    const opOtp = spends.find((r) => r.kind === "spend-otp" && r.appId === "app_op");
    expect(opOtp).toMatchObject({ qty: 1, amountBdt: 0.2 });

    // Strict newest-first ordering by timestamp.
    const stamps = body.rows.map((r) => r.timestamp);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);

    // Additive context totals keep their semantics (request pipeline).
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

  it("cursor-paginates strictly (max 100 rows per page, lossless, no duplicates)", async () => {
    // Push the report past one page: 105 more settled purchases.
    const pkg = app.db.prepare("SELECT id FROM packages WHERE package_code = 'otp100'").get() as { id: string };
    for (let i = 1; i <= 105; i++) {
      seedTransaction(pkg.id, "otp100", appAId, "approved", NOW - 1000 - i * 2, NOW - 1000 - i * 2);
    }

    const page1 = (await op("GET", "/v5/admin/reports/ledger")).json() as {
      rows: { timestamp: number; kind: string }[];
      nextCursor: string | null;
    };
    expect(page1.rows).toHaveLength(100); // default page = the max
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await op(`GET`, `/v5/admin/reports/ledger?cursor=${encodeURIComponent(page1.nextCursor ?? "")}`)).json() as {
      rows: { timestamp: number; kind: string }[];
      nextCursor: string | null;
    };
    expect(page2.rows).toHaveLength(10); // 105 + 5 seeded = 110 total
    expect(page2.nextCursor).toBeNull();

    // The boundary is strictly descending and the pages are disjoint.
    const first = page1.rows[page1.rows.length - 1];
    const second = page2.rows[0];
    expect((first?.timestamp ?? 0)).toBeGreaterThanOrEqual(second?.timestamp ?? Number.MAX_SAFE_INTEGER);
    const all = [...page1.rows, ...page2.rows];
    const stamps = all.map((r) => r.timestamp);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);

    // Explicit tiny limit also chains losslessly.
    const tiny = (await op("GET", "/v5/admin/reports/ledger?limit=1")).json() as {
      rows: { timestamp: number }[];
      nextCursor: string | null;
    };
    expect(tiny.rows).toHaveLength(1);
    expect(tiny.nextCursor).not.toBeNull();
  });

  it("filters by appId (public) and by date range", async () => {
    const owned = (await op("GET", "/v5/admin/reports/ledger?appId=app_owned")).json() as {
      rows: { appId: string; kind: string }[];
    };
    expect(owned.rows).toHaveLength(4); // purchase + trial + 2 spend groups
    expect(owned.rows.every((r) => r.appId === "app_owned")).toBe(true);

    const opApp = (await op("GET", "/v5/admin/reports/ledger?appId=app_op")).json() as {
      rows: { appId: string; kind: string }[];
    };
    expect(opApp.rows).toHaveLength(1);
    expect(opApp.rows[0]).toMatchObject({ appId: "app_op", kind: "spend-otp" });

    const recent = (await op(`GET`, `/v5/admin/reports/ledger?from=${NOW - 2 * 86400}`)).json() as {
      rows: { kind: string; timestamp: number }[];
    };
    expect(recent.rows).toHaveLength(3); // spend groups only (trial 3d, purchase 4d fall out)
    expect(recent.rows.every((r) => r.kind.startsWith("spend-"))).toBe(true);
  });

  it("streams CSV as the export form — exactly the spec columns, operator gate only", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/v5/admin/reports/ledger" });
    expect(noAuth.statusCode).toBe(401);

    const res = await op("GET", "/v5/admin/reports/ledger?format=csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="ledger-\d+-\d+\.csv"$/);
    const text = res.body;
    expect(text.split("\r\n")[0]).toBe("timestamp,app,kind,package,qty,amountBdt,trxId");
    expect(text).toContain("owned-app"); // app column = display name
    expect(text).toContain("purchase");
    expect(text).toContain("trial");
    expect(text).toContain("spend-otp");
    expect(text).toContain("spend-bulk");
    // Timestamps are ISO-8601 in the human export.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    // The 40-day-old purchase never leaks into the export.
    expect(text.split("\r\n").filter((l) => l.includes("purchase")).length).toBe(1);
  });
});

describe("GET /v5/admin/reports/sends (spec path, derived status)", () => {
  it("classifies kind + derived status + ref + campaign name per message", async () => {
    const res = await op("GET", "/v5/admin/reports/sends");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: {
        timestamp: number;
        messageId: string;
        appId: string | null;
        appName: string | null;
        kind: string;
        recipient: string;
        ref: string | null;
        status: string;
        campaignName: string | null;
        error: string | null;
      }[];
      nextCursor: string | null;
    };
    expect(body.rows).toHaveLength(5);
    expect(body.nextCursor).toBeNull();
    const byId = new Map(body.rows.map((r) => [r.messageId, r]));
    expect(byId.get("m1")).toMatchObject({
      recipient: "+8801711111111",
      kind: "otp",
      ref: "s1",
      status: "verified", // session outcome beats the message state
      campaignName: null,
      appName: "owned-app",
    });
    expect(byId.get("m2")).toMatchObject({
      kind: "bulk",
      ref: "c1",
      status: "failed",
      campaignName: "campaign-1",
      error: "carrier_rejected",
    });
    expect(byId.get("m3")).toMatchObject({ kind: "other", ref: null, status: "pending" });
    expect(byId.get("m4")).toMatchObject({ kind: "otp", ref: "s4", status: "sent" });
    expect(byId.get("m5")).toMatchObject({ kind: "otp", ref: "s5", status: "expired" });
  });

  it("filters by appId and the created-at window", async () => {
    const owned = (await op("GET", "/v5/admin/reports/sends?appId=app_owned")).json() as {
      rows: { messageId: string }[];
    };
    expect(owned.rows.map((r) => r.messageId).sort()).toEqual(["m1", "m2", "m5"]);

    const recent = (await op("GET", `/v5/admin/reports/sends?from=${NOW - 150}`)).json() as {
      rows: { messageId: string }[];
    };
    expect(recent.rows.map((r) => r.messageId)).toEqual(["m1"]);
    const older = (await op("GET", `/v5/admin/reports/sends?to=${NOW - 250}`)).json() as {
      rows: { messageId: string }[];
    };
    // to=NOW-250 keeps messages created at NOW-300/-400/-500 (m2 at -200 is newer).
    expect(older.rows.map((r) => r.messageId).sort()).toEqual(["m3", "m4", "m5"]);
  });

  it("cursor-paginates strictly (max 100/page)", async () => {
    const page1 = (await op("GET", "/v5/admin/reports/sends?limit=2")).json() as {
      rows: { messageId: string; timestamp: number }[];
      nextCursor: string | null;
    };
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await op(`GET`, `/v5/admin/reports/sends?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`)).json() as {
      rows: { messageId: string; timestamp: number }[];
      nextCursor: string | null;
    };
    expect(page2.rows).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();
    const page3 = (await op(`GET`, `/v5/admin/reports/sends?limit=2&cursor=${encodeURIComponent(page2.nextCursor ?? "")}`)).json() as {
      rows: { messageId: string }[];
      nextCursor: string | null;
    };
    expect(page3.rows).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const ids = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.messageId);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5); // lossless: every row exactly once
    const stamps = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.timestamp);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);

    // Explicit cap: limit is clamped to the spec's 100 rows/page.
    const huge = (await op("GET", "/v5/admin/reports/sends?limit=500")).json() as { rows: unknown[] };
    expect(huge.rows.length).toBeLessThanOrEqual(100);
  });

  it("streams PII CSV with spreadsheet-formula guard and the spec columns, operator gate only", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/v5/admin/reports/sends" });
    expect(noAuth.statusCode).toBe(401);

    const res = await op("GET", "/v5/admin/reports/sends?format=csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="send-log-\d+-\d+\.csv"$/);
    const text = res.body;
    expect(text.split("\r\n")[0]).toBe("timestamp,app,kind,recipient,ref,status,campaignName");
    // Recipient numbers are present (operator-only export) but formula-guarded:
    // a leading + would otherwise execute as a formula in spreadsheets.
    expect(text).toContain("'+8801711111111");
    expect(text).toContain("'+8801712222222");
    expect(text).toContain("campaign-1");
    expect(text).toContain("verified");

    // The superseded ISSUE-83 path is gone (spec renamed it to /sends).
    const gone = await op("GET", "/v5/admin/reports/send-log");
    expect(gone.statusCode).toBe(404);
  });
});
