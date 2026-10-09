/**
 * STAGE F5 (ISSUE-83): payment SMS surfacing + auto-attach proposal engine.
 * Covers the ordered invariants:
 * - candidate matching by amount (+/- tolerance) inside a time window, both
 *   parameters READ FROM payment_match_config (operator-tunable, not hardcoded
 *   — proven by mutating config and observing the candidate set change);
 * - one-click confirm awards atomically (attach + trx_id + credits commit
 *   together; failure paths leave the transaction pending, nothing partial);
 * - ambiguity (>1 candidate) is surfaced, never auto-resolved — attach
 *   requires an explicit transactionId;
 * - operator gate (requireOperator) on every route.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "payments-test-jwt-0123456789abcdef0123456789abcdef";
const OPERATOR = "payments-operator-secret-0123456789abcdef";
const BKASH = "+8801711000000";

const CRED = {
  "x-app-id": "app_pay",
  "x-app-secret": "secret-pay-0123456789abcdef0123456789abcdef",
};
const PKG = {
  packageCode: "otp200",
  name: "OTP 200",
  smsQuota: 200,
  priceBdt: 200,
  validityDays: 30,
  type: "otp",
};

let app: FastifyInstance;

function seedApp(): void {
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(crypto.randomUUID(), CRED["x-app-id"], sha256Hex(CRED["x-app-secret"]), "pay-app");
}

/** Inserts an ingested payment-SMS row directly (device ingest itself is device-plane tested). */
function seedPayment(txnId: string, paisa: number, receivedAt: number): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO payment_sms (id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at) " +
        "VALUES (?, NULL, '+8801613000000', 'bkash', ?, ?, ?, unixepoch())",
    )
    .run(id, txnId, paisa, receivedAt);
  return id;
}

function op(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${OPERATOR}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Full happy-path purchase: package upsert + pending transaction (no TrxID yet). */
async function purchase(): Promise<string> {
  const up = await op("POST", "/v5/admin/billing/packages", PKG);
  expect(up.statusCode).toBe(201);
  const req = await app.inject({
    method: "POST",
    url: "/v5/billing/credits/request",
    headers: CRED,
    payload: { packageCode: PKG.packageCode },
  });
  expect(req.statusCode).toBe(201);
  return (req.json() as { transactionId: string }).transactionId;
}

function transactionRow(id: string): {
  status: string;
  trx_id: string | null;
  amount_bdt: number;
} {
  return app.db
    .prepare("SELECT status, trx_id, amount_bdt FROM credit_transactions WHERE id = ?")
    .get(id) as { status: string; trx_id: string | null; amount_bdt: number };
}

function otpCredits(): number {
  const row = app.db.prepare("SELECT otp_sms_remaining FROM app_credits").get() as
    | { otp_sms_remaining: number }
    | undefined;
  return row?.otp_sms_remaining ?? 0;
}

beforeEach(() => {
  app = buildApp({
    dbPath: join(mkdtempSync(join(tmpdir(), "dprelay-pay-test-")), "test.db"),
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: OPERATOR,
      BKASH_PERSONAL_NUMBER: BKASH,
    },
  });
  seedApp();
});

afterEach(async () => {
  await app.close();
});

describe("GET /v5/admin/payments (surfacing + candidates)", () => {
  it("lists ingested payment SMS with match status and a candidate under seeded config", async () => {
    const transactionId = await purchase();
    const now = Math.floor(Date.now() / 1000);
    seedPayment("PAYTXN00001", 20000, now); // 200.00 BDT == package price

    const res = await op("GET", "/v5/admin/payments");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      config: { toleranceBdt: number; windowSec: number };
      payments: {
        txnId: string;
        amountBdt: number;
        matched: unknown;
        candidates: { transactionId: string; deltaBdt: number }[];
        ambiguous: boolean;
      }[];
    };
    // Seed values live in migration 014 (operator-tunable, flagged defaults).
    expect(body.config).toMatchObject({ toleranceBdt: 100, windowSec: 604800 });
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ txnId: "PAYTXN00001", amountBdt: 200, matched: null, ambiguous: false });
    expect(body.payments[0].candidates.map((c) => c.transactionId)).toEqual([transactionId]);
  });

  it("requires the operator secret", async () => {
    const res = await app.inject({ method: "GET", url: "/v5/admin/payments" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_operator_secret" });
  });
});

describe("tunable match config (NOT hardcoded)", () => {
  it("PUT validates input and persists for subsequent matching", async () => {
    const bad1 = await op("PUT", "/v5/admin/payments/config", { toleranceBdt: -1 });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.json()).toMatchObject({ code: "invalid_match_config" });
    const bad2 = await op("PUT", "/v5/admin/payments/config", { windowSec: 72000000 });
    expect(bad2.statusCode).toBe(400);
    const bad3 = await op("PUT", "/v5/admin/payments/config", {});
    expect(bad3.statusCode).toBe(400);

    const ok = await op("PUT", "/v5/admin/payments/config", { toleranceBdt: 250, windowSec: 86400 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, toleranceBdt: 250, windowSec: 86400 });

    const get = await op("GET", "/v5/admin/payments/config");
    expect(get.json()).toMatchObject({ toleranceBdt: 250, windowSec: 86400 });
  });

  it("window parameter drives candidate inclusion — a stale payment joins only after the operator widens it", async () => {
    const transactionId = await purchase();
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 86400;
    seedPayment("PAYTXNOLD01", 20000, tenDaysAgo); // outside the seeded 7-day window

    const before = await op("GET", "/v5/admin/payments");
    expect((before.json() as { payments: { candidates: unknown[] }[] }).payments[0].candidates).toEqual([]);

    const widened = await op("PUT", "/v5/admin/payments/config", { windowSec: 30 * 86400 });
    expect(widened.statusCode).toBe(200);

    const after = await op("GET", "/v5/admin/payments");
    const list = after.json() as { payments: { candidates: { transactionId: string }[]; ambiguous: boolean }[] };
    expect(list.payments[0].candidates.map((c) => c.transactionId)).toEqual([transactionId]);
    expect(list.payments[0].ambiguous).toBe(false);
  });

  it("tolerance parameter drives candidate inclusion", async () => {
    await purchase(); // 200 BDT
    const now = Math.floor(Date.now() / 1000);
    seedPayment("PAYTXNFAR1", 50000, now); // 500 BDT — 300 over the seeded 100 tolerance

    const before = await op("GET", "/v5/admin/payments");
    expect((before.json() as { payments: { candidates: unknown[] }[] }).payments[0].candidates).toEqual([]);

    const widened = await op("PUT", "/v5/admin/payments/config", { toleranceBdt: 400 });
    expect(widened.statusCode).toBe(200);

    const after = await op("GET", "/v5/admin/payments");
    expect((after.json() as { payments: { candidates: unknown[] }[] }).payments[0].candidates).toHaveLength(1);
  });
});

describe("POST /v5/admin/payments/:id/attach (one-click confirm)", () => {
  it("attaches and awards credits atomically, then reports the payment as matched", async () => {
    const transactionId = await purchase();
    const paymentId = seedPayment("PAYTXNGOOD1", 20000, Math.floor(Date.now() / 1000));

    const res = await op("POST", `/v5/admin/payments/${paymentId}/attach`, { transactionId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      status: "approved",
      transactionId,
      newOtpBalance: 200,
    });

    const trx = transactionRow(transactionId);
    expect(trx.status).toBe("approved");
    expect(trx.trx_id).toBe("PAYTXNGOOD1");
    expect(otpCredits()).toBe(200);

    const list = (await op("GET", "/v5/admin/payments")).json() as {
      payments: { matched: { transactionId: string; status: string } | null; candidates: unknown[] }[];
    };
    expect(list.payments[0].matched).toMatchObject({ transactionId, status: "approved" });
    expect(list.payments[0].candidates).toEqual([]);
  });

  it("surfaces ambiguity and never auto-awards: two same-amount pendings, both stay pending until an explicit choice", async () => {
    const tx1 = await purchase();
    const tx2 = await purchase();
    const paymentId = seedPayment("PAYTXNAMB01", 20000, Math.floor(Date.now() / 1000));

    const list = (await op("GET", "/v5/admin/payments")).json() as {
      payments: { candidates: { transactionId: string }[]; ambiguous: boolean }[];
    };
    expect(list.payments[0].candidates.map((c) => c.transactionId).sort()).toEqual([tx1, tx2].sort());
    expect(list.payments[0].ambiguous).toBe(true);
    // Nothing was awarded by merely listing (no auto-award path exists).
    expect(transactionRow(tx1).status).toBe("pending");
    expect(transactionRow(tx2).status).toBe("pending");
    expect(otpCredits()).toBe(0);

    // Explicit choice of tx1: wins. tx2 remains pending; the payment cannot fund it twice.
    const first = await op("POST", `/v5/admin/payments/${paymentId}/attach`, { transactionId: tx1 });
    expect(first.statusCode).toBe(200);
    expect(transactionRow(tx2).status).toBe("pending");
    expect(otpCredits()).toBe(200);

    const second = await op("POST", `/v5/admin/payments/${paymentId}/attach`, { transactionId: tx2 });
    expect(second.statusCode).toBe(409);
    expect(transactionRow(tx2).status).toBe("pending");
    expect(otpCredits()).toBe(200); // no double award
  });

  it("rejects out-of-tolerance and out-of-window attaches with 409 and leaves the transaction untouched", async () => {
    const transactionId = await purchase();
    const now = Math.floor(Date.now() / 1000);

    const far = seedPayment("PAYTXNFAR22", 50000, now); // 500 vs 200 BDT
    const farRes = await op("POST", `/v5/admin/payments/${far}/attach`, { transactionId });
    expect(farRes.statusCode).toBe(409);
    expect(farRes.json()).toMatchObject({ code: "amount_out_of_tolerance" });

    const old = seedPayment("PAYTXNOLD22", 20000, now - 10 * 86400); // 10 days vs 7-day window
    const oldRes = await op("POST", `/v5/admin/payments/${old}/attach`, { transactionId });
    expect(oldRes.statusCode).toBe(409);
    expect(oldRes.json()).toMatchObject({ code: "outside_time_window" });

    // Failure paths roll back fully: still pending, no TrxID, no credits.
    expect(transactionRow(transactionId)).toMatchObject({ status: "pending", trx_id: null });
    expect(otpCredits()).toBe(0);
  });

  it("validates input shape and existence", async () => {
    const transactionId = await purchase();
    const paymentId = seedPayment("PAYTXNVAL01", 20000, Math.floor(Date.now() / 1000));

    const noTx = await op("POST", `/v5/admin/payments/${paymentId}/attach`, {});
    expect(noTx.statusCode).toBe(400);
    expect(noTx.json()).toMatchObject({ code: "transaction_required" });

    const unknownPay = await op("POST", "/v5/admin/payments/does-not-exist/attach", { transactionId });
    expect(unknownPay.statusCode).toBe(404);
    expect(unknownPay.json()).toMatchObject({ code: "payment_not_found" });

    const unknownTrx = await op("POST", `/v5/admin/payments/${paymentId}/attach`, {
      transactionId: "no-such-transaction",
    });
    expect(unknownTrx.statusCode).toBe(404);
    expect(unknownTrx.json()).toMatchObject({ code: "transaction_not_found" });

    const noAuth = await app.inject({
      method: "POST",
      url: `/v5/admin/payments/${paymentId}/attach`,
      payload: { transactionId },
    });
    expect(noAuth.statusCode).toBe(401);
  });
});
