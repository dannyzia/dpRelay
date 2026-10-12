/**
 * STAGE F8 (ISSUE-90) → ISSUE-98 — Payment Reader ingest route.
 *
 * Ordered invariants covered:
 * - auth: PAYMENT_READER_SECRET unset → 403 reader_disabled (fail closed);
 *   missing/wrong Bearer → 401 invalid_reader_secret (constant-time compare);
 * - AC3: trxId/amountBdt are OPTIONAL when rawBody is present — the reader's
 *   regex failure payload (trxId "", amountBdt 0) is accepted, not 400;
 * - AC4: valid hints ⇒ fast path with ZERO AI calls (fetch never invoked,
 *   works with no GEMINI key at all);
 * - AC5/AC6: invalid/missing hints + rawBody ⇒ parsePaymentWithAi — Gemini
 *   structured output (responseSchema + application/json asserted on the
 *   wire) when GEMINI_API_KEY is set, the server-side regex fallback when
 *   it is not; extraction fills provider/trxId/amount, provider may be any
 *   of the 5 migration-021 values; not-a-payment → 200 discarded, counterfeit
 *   → 200 discarded, legit-but-incomplete → 200 discarded; a CONFIGURED AI
 *   transport/shape failure → 503 ai_unavailable (nothing persisted, the
 *   reader keeps the SMS and retries);
 * - AC7: every legitimate insert triggers the shared auto-match rule —
 *   response carries autoMatch.candidates / proposedTransactionId, proven
 *   against a real pending purchase; nothing auto-awards;
 * - same pipeline as F8: INSERT OR IGNORE on UNIQUE txn_id, source='reader',
 *   rawBody never persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "reader-test-jwt-0123456789abcdef0123456789abcdef";
const READER = "reader-secret-0123456789abcdef0123456789abcdef";
const OPERATOR = "reader-operator-secret-0123456789abcdef";
const ENROLL = "enroll-only-secret-0123456789abcdef0123456789ab";
const GEMINI_KEY = "gemini-test-key-0123456789abcdef";

const READER_AUTH = { authorization: `Bearer ${READER}` };
const OP_AUTH = { authorization: `Bearer ${OPERATOR}` };

/** A plausible bKash confirmation body (parser parity fixtures live in the APK tests). */
const BODY = "TrxID 8AC3K2L9P1 received from 01712345678. Tk 500.00 paid. Fee Tk 0.00. Balance Tk 1000.00";

let app: FastifyInstance;

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("f8-reader-"), "test.db");
  return buildApp({
    dbPath,
    startCron: false,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      PAYMENT_READER_SECRET: READER,
      OPERATOR_SECRET: OPERATOR,
      DEVICE_ENROLLMENT_SECRET: ENROLL,
      // Needed by the credit-request route used to seed a pending purchase
      // for the AC7 auto-match tests (the route 503s without it).
      BKASH_PERSONAL_NUMBER: "+8801613000000",
      ...extra,
    },
  });
}

function ingest(payload: Record<string, unknown>, auth: Record<string, string> = READER_AUTH) {
  return app.inject({ method: "POST", url: "/v5/payments/ingest", headers: auth, payload });
}

function paymentRow(txnId: string): Record<string, unknown> | undefined {
  return app.db.prepare("SELECT * FROM payment_sms WHERE txn_id = ?").get(txnId) as
    | Record<string, unknown>
    | undefined;
}

/** Standard happy payload: epoch-ms receivedAt, parsed fields, spec-parity rawBody. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sender: "16247",
    amountBdt: 500,
    trxId: "8AC3K2L9P1",
    receivedAt: 1_760_000_123_456,
    rawBody: BODY,
    ...overrides,
  };
}

/** The AC2 regex-failure payload: hints absent, rawBody carries everything. */
function rawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sender: "16247",
    amountBdt: 0,
    trxId: "",
    receivedAt: Date.now(),
    rawBody: BODY,
    ...overrides,
  };
}

/** Envelope Gemini returns around one structured-JSON candidate. */
function geminiEnvelope(extraction: Record<string, unknown>): unknown {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(extraction) }] } }],
  };
}

/** Stubs global fetch and hands back the spy (AI-path tests only). */
function stubFetchResponding(status: number, body: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** App credentials → a real pending purchase (no TrxID yet) for auto-match. */
async function seedPendingPurchase(priceBdt: number): Promise<string> {
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(crypto.randomUUID(), "reader_match_app", sha256Hex("reader-match-secret-0123456789abcdef"), "match-app");
  const up = await app.inject({
    method: "POST",
    url: "/v5/admin/billing/packages",
    headers: { authorization: `Bearer ${OPERATOR}` },
    payload: { packageCode: "otp500", name: "OTP 500", smsQuota: 500, priceBdt, validityDays: 30, type: "otp" },
  });
  expect(up.statusCode).toBe(201);
  const req = await app.inject({
    method: "POST",
    url: "/v5/billing/credits/request",
    headers: { "x-app-id": "reader_match_app", "x-app-secret": "reader-match-secret-0123456789abcdef" },
    payload: { packageCode: "otp500" },
  });
  expect(req.statusCode).toBe(201);
  return (req.json() as { transactionId: string }).transactionId;
}

beforeEach(() => {
  app = makeApp();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe("POST /v5/payments/ingest — auth", () => {
  it("403 reader_disabled fail-closed when PAYMENT_READER_SECRET is unset", async () => {
    await app.close();
    app = makeApp({ PAYMENT_READER_SECRET: "" });
    const r = await ingest(payload());
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ ok: false, code: "reader_disabled" });
    expect(paymentRow("8AC3K2L9P1")).toBeUndefined();
  });

  it("401 invalid_reader_secret without the header", async () => {
    const r = await ingest(payload(), {});
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ ok: false, code: "invalid_reader_secret" });
  });

  it("401 invalid_reader_secret for a wrong secret", async () => {
    const r = await ingest(payload(), { authorization: "Bearer wrong-secret-0123456789abcdef0123456789" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ ok: false, code: "invalid_reader_secret" });
    expect(paymentRow("8AC3K2L9P1")).toBeUndefined();
  });
});

describe("POST /v5/payments/ingest — AC4 fast path (hints present, zero AI)", () => {
  it("201: stores the row tagged source='reader' with derived provider and paisa amount", async () => {
    const r = await ingest(payload());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "8AC3K2L9P1" });

    const row = paymentRow("8AC3K2L9P1");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      sender: "16247",
      provider: "bkash",
      source: "reader",
      amount_paisa: 50000,
      // receivedAt (epoch ms) is floored to seconds, same as the device route.
      received_at: 1_760_000_123,
      device_id: null,
    });
  });

  it("never touches the AI service: no GEMINI key configured and fetch is never called", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called on the fast path");
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await ingest(payload());
    expect(r.statusCode).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies every known sender variant (bKash/BKASH/16247 → bkash, Nagad/NAGAD/16167 → nagad)", async () => {
    const cases: Array<[string, string, string]> = [
      ["bKash", "BKASH12345", "bkash"],
      ["BKASH", "BKASH12346", "bkash"],
      ["16247", "BKASH12347", "bkash"],
      ["Nagad", "NAGAD12345", "nagad"],
      ["NAGAD", "NAGAD12346", "nagad"],
      ["16167", "NAGAD12347", "nagad"],
    ];
    for (const [sender, trxId, provider] of cases) {
      const r = await ingest(payload({ sender, trxId }));
      expect(r.statusCode, `sender=${sender}`).toBe(201);
      expect(paymentRow(trxId)).toMatchObject({ provider, source: "reader" });
    }
  });

  it("400 invalid_payment for an unknown sender (the allowlist gate stays)", async () => {
    const badSender = await ingest(payload({ trxId: "BADSEND123", sender: "+8801711000000" }));
    expect(badSender.statusCode).toBe(400);
    expect(badSender.json()).toMatchObject({ code: "invalid_payment" });
    expect(paymentRow("BADSEND123")).toBeUndefined();
  });

  it("400 when there is neither usable hint nor a rawBody to extract from", async () => {
    const r = await ingest({ sender: "16247", amountBdt: 0, trxId: "short", receivedAt: Date.now() });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "invalid_payment" });
  });
});

describe("POST /v5/payments/ingest — AC3 optional hints fall back cleanly", () => {
  it("regex-failure payload (trxId '', amount 0) with no AI key → regex fallback parses and inserts (no 503)", async () => {
    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "8AC3K2L9P1" });
    expect(paymentRow("8AC3K2L9P1")).toBeDefined();
  });

  it("a structure-free rawBody with no AI key → 200 discarded not_payment, nothing stored", async () => {
    const r = await ingest(rawPayload({ rawBody: "hello world, please check your messages" }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, created: false, discarded: true, reason: "not_payment" });
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("a malformed trxId hint is not a 400 — it falls through to the extraction path", async () => {
    // No key → the regex fallback re-reads the raw body and inserts.
    const r = await ingest(payload({ trxId: "short" }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "8AC3K2L9P1" });
  });

  it("an invalid amount hint (negative) falls through to the extraction path too", async () => {
    const r = await ingest(payload({ amountBdt: -5 }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "8AC3K2L9P1" });
    expect(paymentRow("8AC3K2L9P1")).toMatchObject({ amount_paisa: 50000 });
  });
});

describe("POST /v5/payments/ingest — AC5/AC6 AI extraction path", () => {
  beforeEach(async () => {
    await app.close();
    app = makeApp({ GEMINI_API_KEY: GEMINI_KEY });
  });

  it("sends Gemini structured output (responseSchema + application/json, temperature 0) and stores the extraction", async () => {
    const fetchMock = stubFetchResponding(200, geminiEnvelope({
      isPayment: true,
      isLegitimate: true,
      provider: "rocket",
      trxId: "RKT9XY2B1A",
      amountBdt: 750.5,
      senderPhone: "01712345678",
      counterpartyType: "customer",
      confidence: 0.9,
    }));

    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "RKT9XY2B1A" });

    // Wire contract with the Google GenAI API (AC5).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("models/gemini");
    expect(url).toContain(`key=${GEMINI_KEY}`);
    const body = JSON.parse(String(init.body)) as {
      generationConfig: { temperature: number; responseMimeType: string; responseSchema: { properties: Record<string, unknown> } };
    };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(Object.keys(body.generationConfig.responseSchema.properties)).toEqual(
      expect.arrayContaining(["isLegitimate", "provider", "trxId", "amountBdt", "senderPhone", "counterpartyType"]),
    );

    // Migration 021: any of the 5 AI providers may land, amount from AI.
    expect(paymentRow("RKT9XY2B1A")).toMatchObject({
      provider: "rocket",
      amount_paisa: 75050,
      source: "reader",
    });
  });

  it("AC7: a legitimate insert triggers auto-match and proposes the matching pending order", async () => {
    stubFetchResponding(200, geminiEnvelope({
      isPayment: true,
      isLegitimate: true,
      provider: "bkash",
      trxId: "MATCH00001",
      amountBdt: 500,
      senderPhone: "",
      counterpartyType: "customer",
      confidence: 0.9,
    }));
    const txnId = await seedPendingPurchase(500);

    const r = await ingest(rawPayload({ receivedAt: Date.now() }));
    expect(r.statusCode).toBe(201);
    const body = r.json() as { autoMatch: { candidates: number; proposedTransactionId: string | null } };
    expect(body.autoMatch.candidates).toBe(1);
    expect(body.autoMatch.proposedTransactionId).toBe(txnId);

    // Nothing auto-awarded: the purchase stays pending until a human approves.
    const row = app.db.prepare("SELECT status, trx_id FROM credit_transactions WHERE id = ?").get(txnId) as
      { status: string; trx_id: string | null };
    expect(row.status).toBe("pending");
    expect(row.trx_id).toBeNull();
  });

  it("AC7 counterfeit/fake SMS → 200 discarded + warning, no row, no auto-match", async () => {
    stubFetchResponding(200, geminiEnvelope({
      isPayment: true,
      isLegitimate: false,
      provider: "",
      trxId: "",
      amountBdt: 0,
      senderPhone: "",
      counterpartyType: "unknown",
      confidence: 0.8,
    }));
    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, created: false, discarded: true, reason: "not_legitimate" });
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("legit but incomplete extraction (no trxId) → 200 discarded, never fabricates money data", async () => {
    stubFetchResponding(200, geminiEnvelope({
      isPayment: true,
      isLegitimate: true,
      provider: "bkash",
      trxId: "",
      amountBdt: 0,
      senderPhone: "",
      counterpartyType: "unknown",
      confidence: 0.7,
    }));
    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, created: false, discarded: true, reason: "extraction_incomplete" });
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("AI HTTP failure → 503 ai_unavailable, nothing stored (reader retries)", async () => {
    stubFetchResponding(500, { error: "boom" });
    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ ok: false, code: "ai_unavailable" });
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("AI transport-level rejection → 503 ai_unavailable, nothing stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));
    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "ai_unavailable" });
  });

  it("unparseable model output (not JSON) → 503, never a discard", async () => {
    stubFetchResponding(200, {
      candidates: [{ content: { parts: [{ text: "I cannot classify this message." }] } }],
    });
    const r = await ingest(rawPayload());
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "ai_unavailable" });
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("POST /v5/payments/ingest — AC7 auto-match trigger on the fast path", () => {
  it("proposes the single matching pending order for an exact amount inside the window", async () => {
    const txnId = await seedPendingPurchase(500);
    const r = await ingest(payload({ amountBdt: 500, receivedAt: Date.now() }));
    expect(r.statusCode).toBe(201);
    const body = r.json() as { autoMatch: { candidates: number; proposedTransactionId: string | null } };
    expect(body.autoMatch).toEqual({ candidates: 1, proposedTransactionId: txnId });
  });

  it("reports zero candidates when no pending order matches (nothing to propose)", async () => {
    const r = await ingest(payload({ amountBdt: 500, receivedAt: 1_760_000_123_456 }));
    expect(r.statusCode).toBe(201);
    const body = r.json() as { autoMatch: { candidates: number; proposedTransactionId: string | null } };
    expect(body.autoMatch).toEqual({ candidates: 0, proposedTransactionId: null });
  });
});

describe("POST /v5/payments/ingest — same pipeline as the gateway (F8 invariants)", () => {
  it("idempotent on unique TrxID: a retrying reader queue never double-counts", async () => {
    const first = await ingest(payload());
    expect(first.statusCode).toBe(201);

    const retry = await ingest(payload({ rawBody: "retry with the same parsed fields" }));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ ok: true, created: false, txnId: "8AC3K2L9P1" });

    const count = app.db
      .prepare("SELECT COUNT(*) AS n FROM payment_sms WHERE txn_id = ?")
      .get("8AC3K2L9P1") as { n: number };
    expect(count.n).toBe(1);
  });

  it("rawBody rides along for parity but is never persisted", async () => {
    await ingest(payload());
    const row = paymentRow("8AC3K2L9P1");
    expect(row).toBeDefined();
    const columns = Object.keys(row ?? {});
    expect(columns).not.toContain("raw_body");
    expect(columns).not.toContain("rawBody");
    expect(JSON.stringify(row)).not.toContain("Fee Tk 0.00");
  });

  it("gateway device route rows stay tagged source='gateway'", async () => {
    // Enroll a gateway device, ingest through the device route, and confirm
    // the shared table distinguishes the two ingest paths.
    const enroll = await app.inject({
      method: "POST",
      url: "/v5/device/enroll",
      headers: { authorization: `Bearer ${ENROLL}` },
      payload: { label: "gateway phone" },
    });
    expect(enroll.statusCode).toBe(201);
    const { apiKey } = enroll.json() as { apiKey: string };

    const gw = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        sender: "+8801711000000",
        provider: "bkash",
        txnId: "GW12345678",
        amountPaisa: 10000,
        receivedAt: 1_760_000_000_000,
      },
    });
    expect(gw.statusCode).toBe(201);
    expect(paymentRow("GW12345678")).toMatchObject({ source: "gateway" });
  });

  it("GET /v5/admin/payments exposes source so the panel can render the column", async () => {
    await ingest(payload());
    const list = await app.inject({
      method: "GET",
      url: "/v5/admin/payments",
      headers: OP_AUTH,
    });
    expect(list.statusCode).toBe(200);
    const { payments } = list.json() as { payments: Array<Record<string, unknown>> };
    const readerRow = payments.find((p) => p.txnId === "8AC3K2L9P1");
    expect(readerRow).toBeDefined();
    expect(readerRow?.source).toBe("reader");
  });
});
