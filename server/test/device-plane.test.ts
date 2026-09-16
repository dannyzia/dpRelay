/**
 * M2 device-plane route tests (PLAN §7): enrollment (secret → API key),
 * outstanding claim + at-least-once requeue, results (sent/failed/unknown),
 * payment-SMS ingest (validation + idempotency), FCM token storage.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const TEST_ENROLLMENT_SECRET = "enroll-only-secret-0123456789abcdef0123456789ab";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-device-test-")), "test.db");
  return buildApp({
    dbPath,
    // Enrollment enabled by default: every device-plane flow needs a key. The
    // disabled-path tests override with "" explicitly.
    env: { JWT_SECRET: TEST_JWT_SECRET, DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET, ...extra },
  });
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

/** Enrolls via the public route and returns { deviceId, apiKey }. */
async function enroll(a: FastifyInstance, label = "gateway phone"): Promise<{ deviceId: string; apiKey: string }> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/device/enroll",
    headers: { authorization: `Bearer ${TEST_ENROLLMENT_SECRET}` },
    payload: { label },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Seeds a pending_sms row directly; returns its id. */
function seedPending(
  a: FastifyInstance,
  id: string,
  opts: Partial<{ status: string; claimedAt: number; claimedBy: string; claimedCount: number; createdAt: number }> = {},
): void {
  a.db
    .prepare(
      "INSERT INTO pending_sms (id, to_addr, message, status, claimed_at, claimed_by, claimed_count, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      "+8801700000001",
      `msg-${id}`,
      opts.status ?? "pending",
      opts.claimedAt ?? null,
      opts.claimedBy ?? null,
      opts.claimedCount ?? 0,
      opts.createdAt ?? Math.floor(Date.now() / 1000),
    );
}

describe("POST /v5/device/enroll", () => {
  it("403s when DEVICE_ENROLLMENT_SECRET is not configured", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: "" });
    const res = await app.inject({ method: "POST", url: "/v5/device/enroll", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "enrollment_disabled" });
  });

  it("401s on a wrong secret without creating a device", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/enroll",
      headers: { authorization: "Bearer wrong-secret" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).toEqual({ n: 0 });
  });

  it("mints an API key once and stores only its hash", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET });
    const { deviceId, apiKey } = await enroll(app);

    const row = app.db.prepare("SELECT user_id, api_key_hash FROM devices WHERE id = ?").get(deviceId) as {
      user_id: string | null;
      api_key_hash: string;
    };
    expect(row.user_id).toBeNull();
    expect(row.api_key_hash).not.toBe(apiKey);
    expect(row.api_key_hash).toBe(app.sha256Hex(apiKey));
  });

  it("the minted key authenticates requireDevice routes (heartbeat)", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET });
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/heartbeat",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, heartbeat: "received" });
  });
});

describe("GET /v5/device/outstanding", () => {
  it("requires a device key", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET });
    const res = await app.inject({ method: "GET", url: "/v5/device/outstanding" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "missing_device_key" });
  });

  it("returns pending messages in creation order and claims them", async () => {
    app = makeApp();
    const { deviceId, apiKey } = await enroll(app);
    seedPending(app, "m2", { createdAt: 2000 });
    seedPending(app, "m1", { createdAt: 1000 });

    const res = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: { id: string; to: string; message: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(body.messages[0].message).toBe("msg-m1");

    const claim = app.db.prepare("SELECT status, claimed_by, claimed_count FROM pending_sms WHERE id = 'm1'").get() as {
      status: string;
      claimed_by: string | null;
      claimed_count: number;
    };
    expect(claim.status).toBe("claimed");
    expect(claim.claimed_by).toBe(deviceId);
    expect(claim.claimed_count).toBe(1);
  });

  it("does not re-offer a fresh claim, but requeues a stale one (at-least-once)", async () => {
    app = makeApp({ OUTSTANDING_REQUEUE_SEC: "60" });
    await enroll(app);
    const { apiKey } = await enroll(app);
    const now = Math.floor(Date.now() / 1000);

    seedPending(app, "fresh", { status: "claimed", claimedAt: now - 10 });
    seedPending(app, "stale", { status: "claimed", claimedAt: now - 600 });

    const res = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual(["stale"]);

    const fresh = app.db.prepare("SELECT status FROM pending_sms WHERE id = 'fresh'").get() as { status: string };
    expect(fresh.status).toBe("claimed");
  });

  it("increments claimed_count on requeue re-claims", async () => {
    app = makeApp({ OUTSTANDING_REQUEUE_SEC: "60" });
    await enroll(app);
    const { apiKey } = await enroll(app);
    const now = Math.floor(Date.now() / 1000);
    seedPending(app, "re", { status: "claimed", claimedAt: now - 600, claimedCount: 1 });

    await app.inject({ method: "GET", url: "/v5/device/outstanding", headers: { authorization: `Bearer ${apiKey}` } });

    const row = app.db.prepare("SELECT claimed_count, status FROM pending_sms WHERE id = 're'").get() as {
      claimed_count: number;
      status: string;
    };
    expect(row.claimed_count).toBe(2);
    expect(row.status).toBe("claimed");
  });
});

describe("POST /v5/device/results", () => {
  it("marks claimed messages sent and failed with error text", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);
    seedPending(app, "r1", { createdAt: 1000 });
    seedPending(app, "r2", { createdAt: 2000 });
    // Claim both via the API so the route's WHERE clause (claimed|pending) matches.
    await app.inject({ method: "GET", url: "/v5/device/outstanding", headers: { authorization: `Bearer ${apiKey}` } });

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: "r1", status: "sent" }, { id: "r2", status: "failed", error: "RADIO_OFF" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, accepted: 2, unknown: 0 });

    const r1 = app.db.prepare("SELECT status, error FROM pending_sms WHERE id = 'r1'").get() as { status: string; error: string | null };
    expect(r1.status).toBe("sent");
    expect(r1.error).toBeNull();

    const r2 = app.db.prepare("SELECT status, error FROM pending_sms WHERE id = 'r2'").get() as { status: string; error: string | null };
    expect(r2.status).toBe("failed");
    expect(r2.error).toBe("RADIO_OFF");
  });

  it("counts unknown ids without failing the batch", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: "ghost", status: "sent" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, accepted: 0, unknown: 1 });
  });

  it("400s on a malformed result item", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
  url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: "r1", status: "explosive" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_result_item" });
  });

  it("400s when results is not an array", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: "all-good" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_body" });
  });
});

describe("POST /v5/device/payment-sms", () => {
  it("requires a device key", async () => {
    app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v5/device/payment-sms", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("stores a valid bKash payment and returns 201", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { sender: "bKash", provider: "bkash", txnId: "AB12CD34EF", amountPaisa: 150050, receivedAt: Date.now() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, created: true, txnId: "AB12CD34EF" });

    const row = app.db
      .prepare("SELECT device_id IS NULL AS orphan, amount_paisa, received_at > 0 AS has_time FROM payment_sms WHERE txn_id = 'AB12CD34EF'")
      .get() as { orphan: number; amount_paisa: number; has_time: number };
    expect(row.orphan).toBe(0); // device_id linked
    expect(row.amount_paisa).toBe(150050);
    expect(row.has_time).toBe(1);
  });

  it("is idempotent on duplicate txn_id (200, not double-counted)", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);
    const payload = { sender: "Nagad", provider: "nagad", txnId: "ZZ99YY88XX", amountPaisa: 99000 };

    const first = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, created: false, txnId: "ZZ99YY88XX" });
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM payment_sms").get() as { n: number }).n).toBe(1);
  });

  it("accepts a leading-digit txnId (v4 pattern allows digits anywhere)", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { sender: "bKash", provider: "bkash", txnId: "9AB12CD34E", amountPaisa: 100 },
    });
    expect(res.statusCode).toBe(201);
  });

  it.each(["ab12cd34ef", "SHORT", "AB12CD34EF0", "AB12CD34!"])("rejects invalid txnId %s", async (txnId) => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { sender: "bKash", provider: "bkash", txnId, amountPaisa: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_payment_sms" });
  });

  it("rejects an unknown provider", async () => {
    app = makeApp();
    await enroll(app);
    const { apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/payment-sms",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { sender: "Rocket", provider: "rocket", txnId: "AB12CD34EF", amountPaisa: 100 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v5/device/fcm-token", () => {
  it("stores the token on the device row", async () => {
    app = makeApp();
    const { deviceId, apiKey } = await enroll(app);

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/fcm-token",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { token: "fcm-token-abc123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const row = app.db.prepare("SELECT fcm_token FROM devices WHERE id = ?").get(deviceId) as { fcm_token: string | null };
    expect(row.fcm_token).toBe("fcm-token-abc123");
  });

  it("400s on a missing/oversized token", async () => {
    app = makeApp();
    const { apiKey } = await enroll(app);

    const missing = await app.inject({
      method: "POST",
      url: "/v5/device/fcm-token",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/v5/device/fcm-token",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { token: "x".repeat(5000) },
    });
    expect(oversized.statusCode).toBe(400);
  });
});

describe("POST /v5/device/enroll rate limit", () => {
  it("429s with Retry-After after ENROLL_RATE_MAX_PER_HOUR attempts from one IP", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET, ENROLL_RATE_MAX_PER_HOUR: "3" });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v5/device/enroll",
        headers: { authorization: `Bearer ${TEST_ENROLLMENT_SECRET}` },
        payload: { label: `phone-${i}` },
      });
      expect(res.statusCode).toBe(201);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v5/device/enroll",
      payload: { label: "over-the-line" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts failed attempts toward the limit (brute-force guard)", async () => {
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET, ENROLL_RATE_MAX_PER_HOUR: "2" });
    for (let i = 0; i < 2; i++) {
      const bad = await app.inject({
        method: "POST",
        url: "/v5/device/enroll",
        headers: { authorization: "Bearer wrong-secret" },
        payload: {},
      });
      expect(bad.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v5/device/enroll",
      payload: { label: "should-be-limited" },
    });
    expect(limited.statusCode).toBe(429);
  });
});
