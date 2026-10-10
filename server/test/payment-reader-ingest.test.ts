/**
 * STAGE F8 (ISSUE-90) — Payment Reader ingest route.
 *
 * Ordered invariants covered:
 * - auth: PAYMENT_READER_SECRET unset → 403 reader_disabled (fail closed);
 *   missing/wrong Bearer → 401 invalid_reader_secret (constant-time compare);
 * - validation parity with the gateway route: trxId ^[A-Z0-9]{10}$, sender
 *   must classify as bkash/nagad, amountBdt number ≥ 0; malformed → 400;
 * - same pipeline: INSERT OR IGNORE on the UNIQUE txn_id — a duplicate POST
 *   (the reader's offline retry queue) is idempotent, never double-counted;
 * - source tagging: reader rows land with source='reader', the gateway
 *   device route keeps source='gateway', and GET /v5/admin/payments exposes
 *   `source` for the panel's source column;
 * - rawBody is accepted for payload parity but never persisted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "reader-test-jwt-0123456789abcdef0123456789abcdef";
const READER = "reader-secret-0123456789abcdef0123456789abcdef";
const OPERATOR = "reader-operator-secret-0123456789abcdef";
const ENROLL = "enroll-only-secret-0123456789abcdef0123456789ab";

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

beforeEach(() => {
  app = makeApp();
});

afterEach(async () => {
  await app.close();
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

describe("POST /v5/payments/ingest — validation parity with the gateway route", () => {
  it("201: stores the row tagged source='reader' with derived provider and paisa amount", async () => {
    const r = await ingest(payload());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ ok: true, created: true, txnId: "8AC3K2L9P1" });

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

  it("400 invalid_payment for a malformed trxId, unknown sender, or bad amount", async () => {
    const badTrx = await ingest(payload({ trxId: "short" }));
    expect(badTrx.statusCode).toBe(400);
    expect(badTrx.json()).toMatchObject({ code: "invalid_payment" });

    const badSender = await ingest(payload({ trxId: "BADSEND123", sender: "+8801711000000" }));
    expect(badSender.statusCode).toBe(400);

    const badAmount = await ingest(payload({ trxId: "BADAMNT123", amountBdt: -5 }));
    expect(badAmount.statusCode).toBe(400);

    expect(paymentRow("short")).toBeUndefined();
    expect(paymentRow("BADSEND123")).toBeUndefined();
    expect(paymentRow("BADAMNT123")).toBeUndefined();
  });

  it("400 for a non-finite or unsafe amount", async () => {
    const r = await ingest(payload({ trxId: "UNSAFEAMT1", amountBdt: 1e21 }));
    expect(r.statusCode).toBe(400);
    expect(paymentRow("UNSAFEAMT1")).toBeUndefined();
  });
});

describe("POST /v5/payments/ingest — same pipeline as the gateway", () => {
  it("idempotent on unique TrxID: a retrying reader queue never double-counts", async () => {
    const first = await ingest(payload());
    expect(first.statusCode).toBe(201);

    const retry = await ingest(payload({ rawBody: "retry with the same parsed fields" }));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ok: true, created: false, txnId: "8AC3K2L9P1" });

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
