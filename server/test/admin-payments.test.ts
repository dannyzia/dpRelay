/**
 * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 prescriptive spec): payment SMS
 * surfacing + auto-match proposal engine. Covers the ordered invariants:
 * - auto-match rule (exact): TrxID equality OR amount exact-within-tolerance
 *   inside ±payment_match_window_min — both parameters READ from the
 *   admin_config whitelist (GET/PUT /v5/admin/config/:key, never hardcoded —
 *   proven by mutating config and observing the candidate set change);
 * - four match states (unmatched | matched (proposed) | approved | rejected)
 *   with status + received-at filters;
 * - approve awards atomically (attach + trx_id + credits + review state
 *   commit together; failure paths leave the transaction pending, nothing
 *   partial); reject stores the required reason and detaches a pending claim;
 *   ambiguity (>1 candidate) is surfaced, never auto-resolved — approve
 *   409s ambiguous_match, attach requires an explicit transactionId;
 * - operator gate (requireOperator) on every route.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

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
    dbPath: join(testTmpDir("dprelay-pay-test-"), "test.db"),
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
      config: { windowMin: number; windowSec: number; toleranceBdt: number };
      payments: {
        txnId: string;
        amountBdt: number;
        status: string;
        matched: unknown;
        candidates: { transactionId: string; deltaBdt: number }[];
        ambiguous: boolean;
      }[];
    };
    // Spec defaults seeded in migration 014 (ISSUE-84): 30 min / 0 BDT.
    expect(body.config).toMatchObject({ windowMin: 30, windowSec: 1800, toleranceBdt: 0 });
    expect(body.payments).toHaveLength(1);
    // Exactly ONE actionable proposal ⇒ 'matched' (spec's proposed state) —
    // and merely listing must never award anything.
    expect(body.payments[0]).toMatchObject({ txnId: "PAYTXN00001", amountBdt: 200, status: "matched", matched: null, ambiguous: false });
    expect(body.payments[0].candidates.map((c) => c.transactionId)).toEqual([transactionId]);
    expect(transactionRow(transactionId).status).toBe("pending");
  });

  it("requires the operator secret", async () => {
    const res = await app.inject({ method: "GET", url: "/v5/admin/payments" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_operator_secret" });
  });
});

describe("config whitelist (GET/PUT /v5/admin/config/:key) + tunable matching", () => {
  it("serves exactly the two whitelisted keys with the spec defaults", async () => {
    const win = await op("GET", "/v5/admin/config/payment_match_window_min");
    expect(win.statusCode).toBe(200);
    expect(win.json()).toMatchObject({ ok: true, key: "payment_match_window_min", value: 30 });
    const tol = await op("GET", "/v5/admin/config/payment_match_tolerance_bdt");
    expect(tol.statusCode).toBe(200);
    expect(tol.json()).toMatchObject({ key: "payment_match_tolerance_bdt", value: 0 });
  });

  it("404s unknown keys (the whitelist cannot widen via :key) and 400s invalid values", async () => {
    const unknownGet = await op("GET", "/v5/admin/config/secret_flag");
    expect(unknownGet.statusCode).toBe(404);
    expect(unknownGet.json()).toMatchObject({ code: "unknown_config_key" });
    const unknownPut = await op("PUT", "/v5/admin/config/secret_flag", { value: 1 });
    expect(unknownPut.statusCode).toBe(404);
    expect(unknownPut.json()).toMatchObject({ code: "unknown_config_key" });

    const neg = await op("PUT", "/v5/admin/config/payment_match_tolerance_bdt", { value: -1 });
    expect(neg.statusCode).toBe(400);
    expect(neg.json()).toMatchObject({ code: "invalid_config_value" });
    const huge = await op("PUT", "/v5/admin/config/payment_match_window_min", { value: 999999999 });
    expect(huge.statusCode).toBe(400);
    const missing = await op("PUT", "/v5/admin/config/payment_match_window_min", {});
    expect(missing.statusCode).toBe(400);
    const notInt = await op("PUT", "/v5/admin/config/payment_match_window_min", { value: "30" });
    expect(notInt.statusCode).toBe(400);
  });

  it("requires the operator secret and persists values for subsequent reads", async () => {
    const noAuth = await app.inject({
      method: "GET",
      url: "/v5/admin/config/payment_match_window_min",
    });
    expect(noAuth.statusCode).toBe(401);

    const ok = await op("PUT", "/v5/admin/config/payment_match_window_min", { value: 45 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ key: "payment_match_window_min", value: 45 });
    const get = await op("GET", "/v5/admin/config/payment_match_window_min");
    expect(get.json()).toMatchObject({ value: 45 });
  });

  it("window parameter drives candidate inclusion — a stale payment joins only after the operator widens it", async () => {
    const transactionId = await purchase();
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 86400;
    seedPayment("PAYTXNOLD01", 20000, tenDaysAgo); // outside the default 30-minute window

    const before = await op("GET", "/v5/admin/payments");
    expect((before.json() as { payments: { candidates: unknown[]; status: string }[] }).payments[0]).toMatchObject({ candidates: [], status: "unmatched" });

    const widened = await op("PUT", "/v5/admin/config/payment_match_window_min", { value: 14410 });
    expect(widened.statusCode).toBe(200);

    const after = await op("GET", "/v5/admin/payments");
    const list = after.json() as { payments: { candidates: { transactionId: string }[]; ambiguous: boolean; status: string }[] };
    expect(list.payments[0].candidates.map((c) => c.transactionId)).toEqual([transactionId]);
    expect(list.payments[0].ambiguous).toBe(false);
    expect(list.payments[0].status).toBe("matched");
  });

  it("tolerance parameter drives candidate inclusion (default 0 = exact amount)", async () => {
    await purchase(); // 200 BDT
    const now = Math.floor(Date.now() / 1000);
    seedPayment("PAYTXNFAR1", 50000, now); // 500 BDT — 300 over the exact default

    const before = await op("GET", "/v5/admin/payments");
    expect((before.json() as { payments: { candidates: unknown[] }[] }).payments[0].candidates).toEqual([]);

    const widened = await op("PUT", "/v5/admin/config/payment_match_tolerance_bdt", { value: 400 });
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

    const old = seedPayment("PAYTXNOLD22", 20000, now - 10 * 86400); // 10 days vs default 30-minute window
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

describe("POST /v5/admin/payments/:id/approve (spec one-click)", () => {
  it("awards the single-candidate proposal without an explicit attach, idempotently refusing a second click", async () => {
    const transactionId = await purchase();
    const paymentId = seedPayment("PAYTXNAPR01", 20000, Math.floor(Date.now() / 1000));

    const res = await op("POST", `/v5/admin/payments/${paymentId}/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: "approved", transactionId, newOtpBalance: 200 });
    expect(transactionRow(transactionId)).toMatchObject({ status: "approved", trx_id: "PAYTXNAPR01" });
    expect(otpCredits()).toBe(200);

    const list = (await op("GET", "/v5/admin/payments")).json() as {
      payments: { status: string; reason: string | null }[];
    };
    expect(list.payments[0]).toMatchObject({ status: "approved", reason: null });

    // Double-click must never double-award.
    const again = await op("POST", `/v5/admin/payments/${paymentId}/approve`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "payment_already_approved" });
    expect(otpCredits()).toBe(200);
  });

  it("awards a TrxID-equal pending transaction (auto-match rule, first half)", async () => {
    const transactionId = await purchase();
    const sub = await app.inject({
      method: "POST",
      url: "/v5/billing/credits/submit-trx",
      headers: CRED,
      payload: { transactionId, trxId: "PAYTXNTRX01" },
    });
    expect(sub.statusCode).toBe(200);
    const paymentId = seedPayment("PAYTXNTRX01", 20000, Math.floor(Date.now() / 1000));

    // TrxID equality IS the proposal: matched via the join, no candidates needed.
    const list = (await op("GET", "/v5/admin/payments")).json() as {
      payments: { status: string; matched: { transactionId: string } | null; candidates: unknown[] }[];
    };
    expect(list.payments[0]).toMatchObject({ status: "matched", candidates: [] });
    expect(list.payments[0].matched?.transactionId).toBe(transactionId);

    const res = await op("POST", `/v5/admin/payments/${paymentId}/approve`);
    expect(res.statusCode).toBe(200);
    expect(transactionRow(transactionId)).toMatchObject({ status: "approved", trx_id: "PAYTXNTRX01" });
    expect(otpCredits()).toBe(200);
  });

  it("never resolves ambiguity or absence implicitly (409, nothing awarded)", async () => {
    const tx1 = await purchase();
    const tx2 = await purchase();
    const now = Math.floor(Date.now() / 1000);
    const ambiguous = seedPayment("PAYTXNAMB02", 20000, now);
    const lonely = seedPayment("PAYTXNLONELY", 12345, now); // 123.45 BDT — matches neither 200 BDT pending

    const amb = await op("POST", `/v5/admin/payments/${ambiguous}/approve`);
    expect(amb.statusCode).toBe(409);
    expect(amb.json()).toMatchObject({ code: "ambiguous_match" });
    const none = await op("POST", `/v5/admin/payments/${lonely}/approve`);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: "transaction_required" });

    expect(transactionRow(tx1).status).toBe("pending");
    expect(transactionRow(tx2).status).toBe("pending");
    expect(otpCredits()).toBe(0);
  });

  it("refuses rejected rows, unknown payments, and unauthenticated callers", async () => {
    const paymentId = seedPayment("PAYTXNREJ01", 20000, Math.floor(Date.now() / 1000));
    const rejected = await op("POST", `/v5/admin/payments/${paymentId}/reject`, { reason: "duplicate ingestion" });
    expect(rejected.statusCode).toBe(200);

    const afterReject = await op("POST", `/v5/admin/payments/${paymentId}/approve`);
    expect(afterReject.statusCode).toBe(409);
    expect(afterReject.json()).toMatchObject({ code: "payment_rejected" });

    const unknown = await op("POST", "/v5/admin/payments/does-not-exist/approve");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "payment_not_found" });

    const noAuth = await app.inject({ method: "POST", url: `/v5/admin/payments/${paymentId}/approve` });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe("POST /v5/admin/payments/:id/reject (reason stored, shown on the row)", () => {
  it("requires a non-empty reason", async () => {
    const paymentId = seedPayment("PAYTXNRSN001", 20000, Math.floor(Date.now() / 1000));
    const missing = await op("POST", `/v5/admin/payments/${paymentId}/reject`, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "reason_required" });
    const empty = await op("POST", `/v5/admin/payments/${paymentId}/reject`, { reason: "   " });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: "reason_required" });
  });

  it("stores the reason and surfaces it on the row's status", async () => {
    const paymentId = seedPayment("PAYTXNRSN002", 20000, Math.floor(Date.now() / 1000));
    const res = await op("POST", `/v5/admin/payments/${paymentId}/reject`, { reason: "sender not our customer" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: "rejected", reason: "sender not our customer" });

    const list = (await op("GET", "/v5/admin/payments")).json() as {
      payments: { status: string; reason: string | null }[];
    };
    expect(list.payments[0]).toMatchObject({ status: "rejected", reason: "sender not our customer" });

    const unknown = await op("POST", "/v5/admin/payments/does-not-exist/reject", { reason: "x" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "payment_not_found" });
  });

  it("detaches a pending claim's TrxID so a corrected TrxID can be submitted", async () => {
    const transactionId = await purchase();
    const sub = await app.inject({
      method: "POST",
      url: "/v5/billing/credits/submit-trx",
      headers: CRED,
      payload: { transactionId, trxId: "PAYTXNDET01" },
    });
    expect(sub.statusCode).toBe(200);
    const paymentId = seedPayment("PAYTXNDET01", 20000, Math.floor(Date.now() / 1000));

    const res = await op("POST", `/v5/admin/payments/${paymentId}/reject`, { reason: "wrong amount evidence" });
    expect(res.statusCode).toBe(200);

    // Transaction untouched apart from the detach: still pending, TrxID freed.
    expect(transactionRow(transactionId)).toMatchObject({ status: "pending", trx_id: null });
    expect(otpCredits()).toBe(0);

    // The customer's corrected TrxID is no longer blocked by the rejected one.
    const corrected = await app.inject({
      method: "POST",
      url: "/v5/billing/credits/submit-trx",
      headers: CRED,
      payload: { transactionId, trxId: "PAYTXNNEW01" },
    });
    expect(corrected.statusCode).toBe(200);
    expect(transactionRow(transactionId).trx_id).toBe("PAYTXNNEW01");

    // And the rejected payment row cannot be attached behind the operator's back.
    const attach = await op("POST", `/v5/admin/payments/${paymentId}/attach`, { transactionId });
    expect(attach.statusCode).toBe(409);
    expect(attach.json()).toMatchObject({ code: "payment_rejected" });
  });

  it("cannot undo an approved payment", async () => {
    const transactionId = await purchase();
    const paymentId = seedPayment("PAYTXNAPR02", 20000, Math.floor(Date.now() / 1000));
    const approve = await op("POST", `/v5/admin/payments/${paymentId}/approve`);
    expect(approve.statusCode).toBe(200);

    const res = await op("POST", `/v5/admin/payments/${paymentId}/reject`, { reason: "changed my mind" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "payment_already_approved" });
    expect(transactionRow(transactionId).status).toBe("approved");
    expect(otpCredits()).toBe(200);
  });
});

describe("GET /v5/admin/payments filters (status / from / to)", () => {
  it("filters by each match status and rejects unknown statuses", async () => {
    const now = Math.floor(Date.now() / 1000);
    const txA = await purchase(); // for the matched proposal
    seedPayment("PAYTXNUNM1", 99900, now); // 999 BDT — no proposal → unmatched
    seedPayment("PAYTXNMAT01", 20000, now); // single candidate (txA) → matched

    const m = (await op("GET", "/v5/admin/payments?status=matched")).json() as { payments: { txnId: string }[] };
    expect(m.payments.map((p) => p.txnId)).toEqual(["PAYTXNMAT01"]);

    const listAll = (await op("GET", "/v5/admin/payments")).json() as {
      payments: { id: string; txnId: string }[];
    };
    const matchedRow = listAll.payments.find((p) => p.txnId === "PAYTXNMAT01");
    expect(matchedRow).toBeDefined();
    const approved = await op("POST", `/v5/admin/payments/${matchedRow?.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(transactionRow(txA).status).toBe("approved");

    // Rejected row: no pending exists yet (txA approved), so 0 candidates.
    const rejectedId = seedPayment("PAYTXNREJ03", 44400, now);
    const rej = await op("POST", `/v5/admin/payments/${rejectedId}/reject`, { reason: "test rejection" });
    expect(rej.statusCode).toBe(200);

    // Leave ONE open proposal: exactly one pending (txC) at query time.
    const txC = await purchase();
    expect(transactionRow(txC).status).toBe("pending");
    seedPayment("PAYTXNMAT02", 20000, now); // single candidate → matched

    const unmatched = (await op("GET", "/v5/admin/payments?status=unmatched")).json() as { payments: { txnId: string }[] };
    expect(unmatched.payments.map((p) => p.txnId)).toEqual(["PAYTXNUNM1"]);
    const matched = (await op("GET", "/v5/admin/payments?status=matched")).json() as { payments: { txnId: string }[] };
    expect(matched.payments.map((p) => p.txnId)).toEqual(["PAYTXNMAT02"]);
    const approvedRows = (await op("GET", "/v5/admin/payments?status=approved")).json() as { payments: { txnId: string }[] };
    expect(approvedRows.payments.map((p) => p.txnId)).toEqual(["PAYTXNMAT01"]);
    const rejectedRows = (await op("GET", "/v5/admin/payments?status=rejected")).json() as { payments: { txnId: string }[] };
    expect(rejectedRows.payments.map((p) => p.txnId)).toEqual(["PAYTXNREJ03"]);
    const all = (await op("GET", "/v5/admin/payments")).json() as { payments: unknown[] };
    expect(all.payments).toHaveLength(4);

    const bad = await op("GET", "/v5/admin/payments?status=bogus");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "invalid_status" });
  });

  it("filters by the received-at window (from/to)", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedPayment("PAYTXNNEAR1", 100, now);
    seedPayment("PAYTXNFAR99", 100, now - 5 * 86400);

    const since = (await op(`GET`, `/v5/admin/payments?from=${now - 2 * 86400}`)).json() as {
      payments: { txnId: string }[];
    };
    expect(since.payments.map((p) => p.txnId)).toEqual(["PAYTXNNEAR1"]);
    const until = (await op(`GET`, `/v5/admin/payments?to=${now - 4 * 86400}`)).json() as {
      payments: { txnId: string }[];
    };
    expect(until.payments.map((p) => p.txnId)).toEqual(["PAYTXNFAR99"]);
    const both = (await op(`GET`, `/v5/admin/payments?from=${now - 6 * 86400}&to=${now + 60}`)).json() as {
      payments: { txnId: string }[];
    };
    // Lexicographic sort: F < N.
    expect(both.payments.map((p) => p.txnId).sort()).toEqual(["PAYTXNFAR99", "PAYTXNNEAR1"]);
  });
});
