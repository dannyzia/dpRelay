/**
 * ISSUE-98 (stage order round 2) — server/test/payment-reader-ai.test.ts.
 *
 * The four tests the stage order names, against the real route:
 * 1. fast-path deterministic insert (valid hints → zero AI calls, even with
 *    a GEMINI key configured and fetch sabotaged);
 * 2. fallback / AI parser with a Bengali bKash SMS fixture — no key → the
 *    server-side regex fallback parses Bengali digits + labelled TrxID; with
 *    a key → the Gemini path stores the extraction;
 * 3. fake personal SMS detection (counterfeit rejection) — personal sender
 *    never parses (400), AI verdict isLegitimate=false discards, and the
 *    no-key fallback discards a structure-free body as not_payment;
 * 4. duplicate TrxID idempotency — the AI path re-extraction of the same
 *    TrxID never double-counts (INSERT OR IGNORE on UNIQUE txn_id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "reader-ai-test-jwt-0123456789abcdef0123456789";
const READER = "reader-ai-secret-0123456789abcdef0123456789abcdef";
const GEMINI_KEY = "gemini-ai-test-key-0123456789abcdef";

const READER_AUTH = { authorization: `Bearer ${READER}` };

/** Bengali bKash fixture: Bengali digits + ৳ amount + labelled TrxID + balance line. */
const BENGALI_BODY =
  "৳১২৫০.০০ টাকা প্রাপ্ত হয়েছে। TrxID: 7GH8JK9LMN। ব্যালেন্স ৳৫৩২৫০.০০";

let app: FastifyInstance;

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("reader-ai-"), "test.db");
  return buildApp({
    dbPath,
    startCron: false,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      PAYMENT_READER_SECRET: READER,
      ...extra,
    },
  });
}

function ingest(payload: Record<string, unknown>): ReturnType<FastifyInstance["inject"]> {
  return app.inject({ method: "POST", url: "/v5/payments/ingest", headers: READER_AUTH, payload });
}

function paymentRow(txnId: string): Record<string, unknown> | undefined {
  return app.db.prepare("SELECT * FROM payment_sms WHERE txn_id = ?").get(txnId) as
    | Record<string, unknown>
    | undefined;
}

function paymentCount(): number {
  return (app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number }).n;
}

/** Raw-forward payload: the reader's regex failed, so hints are empty/0. */
function rawPayload(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sender: "16247",
    amountBdt: 0,
    trxId: "",
    receivedAt: Date.now(),
    rawBody: body,
    ...overrides,
  };
}

/** Envelope Gemini returns around one structured-JSON candidate. */
function geminiEnvelope(extraction: Record<string, unknown>): unknown {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(extraction) }] } }] };
}

beforeEach(() => {
  app = makeApp();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe("1. fast-path deterministic insert (zero AI)", () => {
  it("valid hints insert directly even with a GEMINI key configured and fetch sabotaged", async () => {
    await app.close();
    app = makeApp({ GEMINI_API_KEY: GEMINI_KEY });
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called on the fast path");
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await ingest({
      sender: "16247",
      trxId: "8AC3K2L9P1",
      amountBdt: 500,
      receivedAt: 1_760_000_123_456,
      rawBody: "TrxID 8AC3K2L9P1 received. Tk 500.00 paid.",
    });

    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "8AC3K2L9P1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(paymentRow("8AC3K2L9P1")).toMatchObject({
      provider: "bkash",
      amount_paisa: 50000,
      source: "reader",
    });
  });
});

describe("2. fallback / AI parser with a Bengali bKash SMS fixture", () => {
  it("no GEMINI key → server-side regex fallback parses Bengali digits + labelled TrxID", async () => {
    const r = await ingest(rawPayload(BENGALI_BODY));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "7GH8JK9LMN" });
    expect(paymentRow("7GH8JK9LMN")).toMatchObject({
      provider: "bkash",
      amount_paisa: 125000,
      source: "reader",
    });
  });

  it("GEMINI key configured → the Gemini path extracts and stores the same fixture", async () => {
    await app.close();
    app = makeApp({ GEMINI_API_KEY: GEMINI_KEY });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            geminiEnvelope({
              isPayment: true,
              isLegitimate: true,
              provider: "bkash",
              trxId: "7GH8JK9LMN",
              amountBdt: 1250,
              senderPhone: null,
              counterpartyType: "customer",
              confidence: 0.9,
            }),
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const r = await ingest(rawPayload(BENGALI_BODY));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, created: true, txnId: "7GH8JK9LMN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(paymentRow("7GH8JK9LMN")).toMatchObject({ amount_paisa: 125000, source: "reader" });
  });
});

describe("3. fake personal SMS detection (counterfeit rejection)", () => {
  it("a personal sender never reaches the parser: 400 invalid_payment, no row", async () => {
    const r = await ingest(rawPayload("hi, I just sent you 500 taka, TrxID: FAKE12345", {
      sender: "+8801711000000",
    }));
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ ok: false, code: "invalid_payment" });
    expect(paymentCount()).toBe(0);
  });

  it("AI verdict isLegitimate=false → 200 discarded not_legitimate, no row", async () => {
    await app.close();
    app = makeApp({ GEMINI_API_KEY: GEMINI_KEY });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              geminiEnvelope({
                isPayment: true,
                isLegitimate: false,
                provider: "bkash",
                trxId: "SCAM123456",
                amountBdt: 999,
                senderPhone: null,
                counterpartyType: "unknown",
                confidence: 0.8,
              }),
            ),
            { status: 200 },
          ),
      ),
    );

    const r = await ingest(rawPayload("Send me money, TrxID SCAM123456, Tk 999.00"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, created: false, discarded: true, reason: "not_legitimate" });
    expect(paymentCount()).toBe(0);
  });

  it("no-key fallback: a structure-free body from a payment sender → discarded not_payment", async () => {
    const r = await ingest(rawPayload(
      "Your account will be suspended. Call 01712345678 to verify your identity.",
    ));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, created: false, discarded: true, reason: "not_payment" });
    expect(paymentCount()).toBe(0);
  });
});

describe("4. duplicate TrxID idempotency (AI path)", () => {
  it("re-extracting the same TrxID twice never double-counts", async () => {
    await app.close();
    app = makeApp({ GEMINI_API_KEY: GEMINI_KEY });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              geminiEnvelope({
                isPayment: true,
                isLegitimate: true,
                provider: "nagad",
                trxId: "DUP9Y8X7W6",
                amountBdt: 300,
                senderPhone: null,
                counterpartyType: "customer",
                confidence: 0.95,
              }),
            ),
            { status: 200 },
          ),
      ),
    );

    const first = await ingest(rawPayload("Nagad TrxID DUP9Y8X7W6. Tk 300.00 received."));
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ created: true, txnId: "DUP9Y8X7W6" });

    const retry = await ingest(rawPayload("Nagad TrxID DUP9Y8X7W6. Tk 300.00 received."));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ ok: true, created: false, txnId: "DUP9Y8X7W6" });

    const count = app.db
      .prepare("SELECT COUNT(*) AS n FROM payment_sms WHERE txn_id = ?")
      .get("DUP9Y8X7W6") as { n: number };
    expect(count.n).toBe(1);
  });
});
