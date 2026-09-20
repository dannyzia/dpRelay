/**
 * M4 pass 1 — billing plane tests (PLAN §10, Addendum #1). Centerpiece: the
 * single-award guarantee — one bKash TrxID can fund exactly one transaction,
 * enforced by the partial UNIQUE index (database level) and the submit/approve
 * guards (application level). Also covers the package catalog, operator gate,
 * request → submit → approve/reject lifecycle, snapshot semantics (package
 * edits do not rewrite history), expiry extension, pagination, and invoice.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "billing-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "billing-operator-secret-0123456789abcdef0123";
const BKASH = "+8801711000000";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-billing-test-")), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: TEST_OPERATOR_SECRET,
      BKASH_PERSONAL_NUMBER: BKASH,
      ...extra,
    },
  });
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

/** Inserts an app row directly: billing tests isolate from the provisioning route. */
function seedApp(appId: string, appSecret: string): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(id, appId, sha256Hex(appSecret), appId);
  return id;
}

const CRED_A = { "x-app-id": "app_a", "x-app-secret": "secret-a-0123456789abcdef0123456789abcdef" };
const CRED_B = { "x-app-id": "app_b", "x-app-secret": "secret-b-0123456789abcdef0123456789abcdef" };

async function opPost(url: string, payload: unknown, secret: string = TEST_OPERATOR_SECRET) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${secret}` },
    payload,
  });
}

/** Full happy-path purchase for one app; returns the created transactionId. */
async function purchase(
  creds: Record<string, string>,
  packageCode: string,
  trxId: string,
): Promise<string> {
  const req = await app.inject({ method: "POST", url: "/v5/billing/credits/request", headers: creds, payload: { packageCode } });
  expect(req.statusCode).toBe(201);
  const { transactionId } = req.json() as { transactionId: string };
  const sub = await app.inject({ method: "POST", url: "/v5/billing/credits/submit-trx", headers: creds, payload: { transactionId, trxId } });
  expect(sub.statusCode).toBe(200);
  return transactionId;
}

async function upsertPackage(body: Record<string, unknown>) {
  return opPost("/v5/admin/billing/packages", body);
}

const PKG = { packageCode: "otp100", name: "OTP 100", smsQuota: 100, priceBdt: 200, validityDays: 30, type: "otp" };

describe("operator gate (requireOperator)", () => {
  it("503 admin_disabled when OPERATOR_SECRET is unset; 401 without/wrong secret when set", async () => {
    app = makeApp({ OPERATOR_SECRET: "" });
    const disabled = await opPost("/v5/admin/billing/packages", PKG, TEST_OPERATOR_SECRET);
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().code).toBe("admin_disabled");

    await app.close();
    app = makeApp();
    const noHeader = await app.inject({ method: "POST", url: "/v5/admin/billing/packages", payload: PKG });
    expect(noHeader.statusCode).toBe(401);
    // One uniform code for absent-or-wrong: the comparison is constant-time
    // even when the header is missing, so the two cases are indistinguishable
    // by design (middleware.ts requireOperator).
    expect(noHeader.json().code).toBe("invalid_operator_secret");
    const wrong = await opPost("/v5/admin/billing/packages", PKG, "wrong-secret-wrong-secret-wrong-secret12");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("invalid_operator_secret");
  });
});

describe("package catalog + upsert", () => {
  it("public list shows active packages sorted by type then price; inactive hidden", async () => {
    app = makeApp();
    expect((await app.inject({ method: "GET", url: "/v5/billing/packages" })).json().packages).toEqual([]);
    await upsertPackage(PKG);
    await upsertPackage({ packageCode: "bulk500", name: "Bulk 500", smsQuota: 500, priceBdt: 900, validityDays: 30, type: "bulk" });
    await upsertPackage({ packageCode: "otp100cheap", name: "OTP 100 cheap", smsQuota: 100, priceBdt: 150, validityDays: 30, type: "otp" });
    await upsertPackage({ packageCode: "hidden", name: "Hidden", smsQuota: 1, priceBdt: 1, validityDays: 1, type: "otp", isActive: false });

    const list = (await app.inject({ method: "GET", url: "/v5/billing/packages" })).json() as { packages: { packageCode: string; priceBdt: number }[] };
    expect(list.packages.map((p) => p.packageCode)).toEqual(["otp100cheap", "otp100", "bulk500"]);

    // Upsert same code updates in place (no duplicate row).
    await upsertPackage({ ...PKG, priceBdt: 250 });
    const after = (await app.inject({ method: "GET", url: "/v5/billing/packages" })).json() as { packages: { packageCode: string; priceBdt: number }[] };
    expect(after.packages.filter((p) => p.packageCode === "otp100")).toHaveLength(1);
    expect(after.packages.find((p) => p.packageCode === "otp100")?.priceBdt).toBe(250);
  });

  it("rejects malformed package payloads with 400", async () => {
    app = makeApp();
    for (const bad of [{ packageCode: "x", name: "n", smsQuota: 1, priceBdt: 1, validityDays: 1 }, { ...PKG, smsQuota: 0 }, { ...PKG, type: "sms" }]) {
      const res = await upsertPackage(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().ok).toBe(false);
    }
  });
});

describe("credit request → submit → approve lifecycle", () => {
  it("request fails closed without BKASH_PERSONAL_NUMBER; happy path returns destination", async () => {
    app = makeApp({ BKASH_PERSONAL_NUMBER: "" });
    seedApp("app_a", CRED_A["x-app-secret"]);
    const res = await app.inject({ method: "POST", url: "/v5/billing/credits/request", headers: CRED_A, payload: { packageCode: "otp100" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("payment_destination_unconfigured");
  });

  it("request snapshots the package; inactive/unknown package → 404", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage(PKG);
    const res = await app.inject({ method: "POST", url: "/v5/billing/credits/request", headers: CRED_A, payload: { packageCode: "otp100" } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { transactionId: string; bkashNumber: string; amountBdt: number };
    expect(body.bkashNumber).toBe(BKASH);
    expect(body.amountBdt).toBe(200);
    const row = app.db.prepare("SELECT sms_quota, amount_bdt, status FROM credit_transactions WHERE id = ?").get(body.transactionId) as { sms_quota: number; amount_bdt: number; status: string };
    expect(row).toMatchObject({ sms_quota: 100, amount_bdt: 200, status: "pending" });

    await upsertPackage({ ...PKG, isActive: false });
    const gone = await app.inject({ method: "POST", url: "/v5/billing/credits/request", headers: CRED_A, payload: { packageCode: "otp100" } });
    expect(gone.statusCode).toBe(404);
  });

  it("submit-trx is scoped to the owning app and pending-only", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    seedApp("app_b", CRED_B["x-app-secret"]);
    await upsertPackage(PKG);
    const req = await app.inject({ method: "POST", url: "/v5/billing/credits/request", headers: CRED_A, payload: { packageCode: "otp100" } });
    const { transactionId } = req.json() as { transactionId: string };

    const foreign = await app.inject({ method: "POST", url: "/v5/billing/credits/submit-trx", headers: CRED_B, payload: { transactionId, trxId: "TRX1" } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("transaction_not_found");

    const ok = await app.inject({ method: "POST", url: "/v5/billing/credits/submit-trx", headers: CRED_A, payload: { transactionId, trxId: "  TRX1  " } });
    expect(ok.statusCode).toBe(200);
    const stored = app.db.prepare("SELECT trx_id FROM credit_transactions WHERE id = ?").get(transactionId) as { trx_id: string };
    expect(stored.trx_id).toBe("TRX1"); // trimmed

    // Same TrxID again = idempotent no-op (double-tap safety).
    const same = await app.inject({ method: "POST", url: "/v5/billing/credits/submit-trx", headers: CRED_A, payload: { transactionId, trxId: "TRX1" } });
    expect(same.statusCode).toBe(200);

    // A different TrxID on an already-attached pending transaction = 409
    // (overwriting could orphan the customer's real payment).
    const twice = await app.inject({ method: "POST", url: "/v5/billing/credits/submit-trx", headers: CRED_A, payload: { transactionId, trxId: "TRX2" } });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("trx_already_submitted");
  });

  it("CENTERPIECE: one TrxID funds exactly one transaction — attach is unique at DB level and approve cannot double-award", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage(PKG);
    const txA = await purchase(CRED_A, "otp100", "TRX-UNIQUE-1");

    // Approve awards once.
    const approved = await opPost("/v5/admin/billing/approve", { transactionId: txA, approve: true });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ ok: true, status: "approved", newOtpBalance: 100 });

    // Re-approve is an idempotent 409, never a second award.
    const again = await opPost("/v5/admin/billing/approve", { transactionId: txA, approve: true });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("already_resolved");

    // A second transaction cannot attach the same TrxID — blocked at the app layer…
    const reqB = await app.inject({ method: "POST", url: "/v5/billing/credits/request", headers: CRED_A, payload: { packageCode: "otp100" } });
    const txB = (reqB.json() as { transactionId: string }).transactionId;
    const attach = await app.inject({ method: "POST", url: "/v5/billing/credits/submit-trx", headers: CRED_A, payload: { transactionId: txB, trxId: "TRX-UNIQUE-1" } });
    expect(attach.statusCode).toBe(409);
    expect(attach.json().code).toBe("trx_id_already_approved");

    // …and even a raw DB write bypassing the app is rejected by the partial UNIQUE index.
    expect(() =>
      app.db.prepare("UPDATE credit_transactions SET trx_id = ? WHERE id = ?").run("TRX-UNIQUE-1", txB),
    ).toThrowError(/UNIQUE constraint failed/);

    // Balance is exactly one award.
    const credits = (await app.inject({ method: "GET", url: "/v5/billing/credits", headers: CRED_A })).json() as { credits: { otpSmsRemaining: number } };
    expect(credits.credits.otpSmsRemaining).toBe(100);
  });

  it("reject path resolves without awarding; rejectReason stored; re-approve blocked", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage(PKG);
    const tx = await purchase(CRED_A, "otp100", "TRX-REJ-1");
    const rejected = await opPost("/v5/admin/billing/approve", { transactionId: tx, approve: false, rejectReason: "duplicate payment" });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("rejected");
    const row = app.db.prepare("SELECT status, admin_notes FROM credit_transactions WHERE id = ?").get(tx) as { status: string; admin_notes: string };
    expect(row).toMatchObject({ status: "rejected", admin_notes: "duplicate payment" });
    const credits = (await app.inject({ method: "GET", url: "/v5/billing/credits", headers: CRED_A })).json() as { credits: { otpSmsRemaining: number } };
    expect(credits.credits.otpSmsRemaining).toBe(0);
    const late = await opPost("/v5/admin/billing/approve", { transactionId: tx, approve: true });
    expect(late.statusCode).toBe(409);
  });

  it("award respects package type; expiry extends to max(current, now+validity)", async () => {
    app = makeApp();
    const internalId = seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage({ packageCode: "bulk50", name: "b", smsQuota: 50, priceBdt: 100, validityDays: 1, type: "bulk" });
    await upsertPackage({ packageCode: "both200", name: "b2", smsQuota: 200, priceBdt: 400, validityDays: 30, type: "both" });

    const txBulk = await purchase(CRED_A, "bulk50", "TRX-B-1");
    await opPost("/v5/admin/billing/approve", { transactionId: txBulk, approve: true });
    let credits = (await app.inject({ method: "GET", url: "/v5/billing/credits", headers: CRED_A })).json() as { credits: { bulkSmsRemaining: number; otpSmsRemaining: number } };
    expect(credits.credits.bulkSmsRemaining).toBe(50);
    expect(credits.credits.otpSmsRemaining).toBe(0);

    const txBoth = await purchase(CRED_A, "both200", "TRX-B-2");
    const approved = await opPost("/v5/admin/billing/approve", { transactionId: txBoth, approve: true });
    expect(approved.json()).toMatchObject({ newOtpBalance: 200, newBulkBalance: 250 });

    const nowSec = Math.floor(Date.now() / 1000);
    // app_credits is keyed by the INTERNAL id (what requireApp resolves to).
    const row = app.db.prepare("SELECT otp_expires_at FROM app_credits WHERE app_id = ?").get(internalId) as { otp_expires_at: number };
    const expected = nowSec + 30 * 24 * 3600;
    expect(Math.abs(row.otp_expires_at - expected)).toBeLessThan(120);
  });

  it("snapshot semantics: editing the package after request does not change the award", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage(PKG);
    const tx = await purchase(CRED_A, "otp100", "TRX-S-1");
    await upsertPackage({ ...PKG, smsQuota: 999, type: "bulk", priceBdt: 1 });
    const approved = await opPost("/v5/admin/billing/approve", { transactionId: tx, approve: true });
    expect(approved.json()).toMatchObject({ newOtpBalance: 100, newBulkBalance: 0 });
  });
});

describe("operator queue", () => {
  it("lists pending transactions oldest-first; resolved absent", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage(PKG);
    const tx1 = await purchase(CRED_A, "otp100", "TRX-Q-1");
    const tx2 = await purchase(CRED_A, "otp100", "TRX-Q-2");
    await opPost("/v5/admin/billing/approve", { transactionId: tx1, approve: true });

    const queue = (await app.inject({ method: "GET", url: "/v5/admin/billing/queue", headers: { authorization: `Bearer ${TEST_OPERATOR_SECRET}` } })).json() as { pending: { transactionId: string }[] };
    expect(queue.pending.map((t) => t.transactionId)).toEqual([tx2]);
  });
});

describe("transaction history + invoice", () => {
  it("history is app-scoped, filterable, cursor-paginated", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    seedApp("app_b", CRED_B["x-app-secret"]);
    await upsertPackage(PKG);
    for (const trx of ["TRX-H-1", "TRX-H-2", "TRX-H-3"]) await purchase(CRED_A, "otp100", trx);
    await purchase(CRED_B, "otp100", "TRX-H-4");

    const all = (await app.inject({ method: "GET", url: "/v5/billing/transactions", headers: CRED_A })).json() as { transactions: { trxId: string }[]; nextCursor: number | null };
    expect(all.transactions).toHaveLength(3);
    expect(all.nextCursor).toBeNull(); // default page (20) not exhausted

    const page1 = (await app.inject({ method: "GET", url: "/v5/billing/transactions?limit=2", headers: CRED_A })).json() as { transactions: { trxId: string }[]; nextCursor: number | null };
    expect(page1.transactions).toHaveLength(2);
    const page2 = (await app.inject({ method: "GET", url: `/v5/billing/transactions?limit=2&cursor=${page1.nextCursor}`, headers: CRED_A })).json() as { transactions: { trxId: string }[]; nextCursor: number | null };
    expect(page1.transactions.length + page2.transactions.length).toBe(3);
    const seen = [...page1.transactions, ...page2.transactions].map((t) => t.trxId).sort();
    expect(seen).toEqual(["TRX-H-1", "TRX-H-2", "TRX-H-3"]);

    const approved = (await opPost("/v5/admin/billing/approve", { transactionId: (all.transactions[0] as unknown as { transactionId: string }).transactionId, approve: true })).statusCode;
    expect(approved).toBe(200);
    const filtered = (await app.inject({ method: "GET", url: "/v5/billing/transactions?status=approved", headers: CRED_A })).json() as { transactions: unknown[] };
    expect(filtered.transactions).toHaveLength(1);
  });

  it("invoice sums approved purchases in range; invalid range → 400", async () => {
    app = makeApp();
    seedApp("app_a", CRED_A["x-app-secret"]);
    await upsertPackage({ ...PKG, priceBdt: 250 });
    const tx = await purchase(CRED_A, "otp100", "TRX-INV-1");
    await opPost("/v5/admin/billing/approve", { transactionId: tx, approve: true });

    const inv = (await app.inject({ method: "GET", url: "/v5/billing/invoice", headers: CRED_A })).json() as { summary: { totalPurchases: number; totalAmountBdt: number } };
    expect(inv.summary).toMatchObject({ totalPurchases: 1, totalAmountBdt: 250, totalOtpUsed: 0, totalBulkSent: 0 });

    const bad = await app.inject({ method: "GET", url: "/v5/billing/invoice?startDate=2026-01-01&endDate=2025-01-01", headers: CRED_A });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid_date_range");
  });
});
