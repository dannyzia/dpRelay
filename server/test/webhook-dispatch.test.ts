/**
 * M3 tail: signed OTP webhook dispatch tests — dispatch fires on accepted
 * results linked to an otp_session, the X-DP-Signature header is verifiable
 * with the app's secret (recomputed independently via node:crypto), non-2xx
 * responses are retried then succeed, exhausted retries are recorded without
 * failing the phone's POST, and messages without an OTP session or app webhook
 * produce no dispatch at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "webhook-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_ENROLLMENT_SECRET = "enroll-only-secret-0123456789abcdef0123456789ab";
const TEST_APP_ID = "app_hook_1";
const TEST_APP_SECRET = "otp-test-app-secret-0123456789abcdef0123456789ab";
/** apps.webhook_secret — the signing key the receiver (test) must know. */
const WEBHOOK_SECRET = "whsec-0123456789abcdef0123456789abcdef";
const PHONE = "+8801712345678";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-webhook-test-")), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET,
      ...extra,
    },
  });
}

let app: FastifyInstance;

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  if (app) await app.close();
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

/**
 * Seeds the app row (with or without webhook config) plus one pending message
 * linked to an OTP session — the exact topology dispatch resolves at runtime.
 * webhookUrl is the receiver to dispatch against (tests pass the local sink;
 * null simulates "no webhook configured").
 */
function seedOtpPending(a: FastifyInstance, webhookUrl: string | null): void {
  a.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, " +
        "rate_max_per_phone, rate_window_sec, created_at) " +
        "VALUES ('app-row-1', ?, ?, 'Webhook App', ?, ?, 3, 3600, unixepoch())",
    )
    .run(
      TEST_APP_ID,
      sha256Hex(TEST_APP_SECRET),
      webhookUrl,
      webhookUrl !== null ? WEBHOOK_SECRET : null,
    );
  a.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
        "VALUES ('msg-1', 'app_hook_1', ?, 'Your dP Relay verification code is 123456.', 'pending', unixepoch())",
    )
    .run(PHONE);
  a.db
    .prepare(
      "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, attempts, expires_at, status, message_id, created_at) " +
        "VALUES ('sess-1', 'app-row-1', ?, 'otp-hash', 'otp-salt', 0, unixepoch() + 300, 'pending', 'msg-1', unixepoch())",
    )
    .run(PHONE);
}

/** Enrolls via the public route and returns the device API key. */
async function enroll(a: FastifyInstance): Promise<string> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/device/enroll",
    headers: { authorization: `Bearer ${TEST_ENROLLMENT_SECRET}` },
    payload: { label: "gateway" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { apiKey: string }).apiKey;
}

async function postResults(
  a: FastifyInstance,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/device/results",
    headers: { authorization: `Bearer ${apiKey}` },
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

interface SinkRequest {
  signature: string | undefined;
  rawBody: string;
}

/**
 * Local HTTP sink answering each request with the next status from
 * `statusSequence` (last value repeats) while capturing headers + raw bodies.
 */
async function startSink(
  statusSequence: number[],
): Promise<{ url: string; requests: SinkRequest[]; close: () => Promise<void> }> {
  const requests: SinkRequest[] = [];
  let call = 0;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      requests.push({ signature: req.headers["x-dp-signature"], rawBody: data });
      const status = statusSequence[Math.min(call, statusSequence.length - 1)];
      call += 1;
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/otp-status`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** All recorded dispatch attempts, oldest first. */
function deliveryRows(a: FastifyInstance): Array<{
  session_id: string;
  app_id: string;
  webhook_url: string;
  status: string;
  attempt: number;
  attempts_max: number;
  response_code: number | null;
  last_error: string | null;
}> {
  return a.db
    .prepare(
      "SELECT session_id, app_id, webhook_url, status, attempt, attempts_max, response_code, last_error " +
        "FROM webhook_deliveries ORDER BY created_at, attempt",
    )
    .all() as Array<{
    session_id: string;
    app_id: string;
    webhook_url: string;
    status: string;
    attempt: number;
    attempts_max: number;
    response_code: number | null;
    last_error: string | null;
  }>;
}

const expectedPayload = (status: string) => ({
  kind: "otp.status",
  appId: TEST_APP_ID,
  sessionId: "sess-1",
  phone: PHONE,
  status,
});

describe("POST /v5/device/results — OTP webhook dispatch", () => {
  it("dispatches a signed otp.status webhook when an accepted result is OTP-linked", async () => {
    const sink = await startSink([200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    const apiKey = await enroll(app);

    const res = await postResults(app, apiKey, { results: [{ id: "msg-1", status: "sent" }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, unknown: 0 });

    expect(sink.requests).toHaveLength(1);
    const received = sink.requests[0];
    const parsed = JSON.parse(received.rawBody) as Record<string, unknown>;
    expect(parsed).toMatchObject(expectedPayload("sent"));
    expect(typeof parsed.timestamp).toBe("number");

    // Independent verification: HMAC-SHA256 over the exact raw body with the
    // app's plaintext secret (not the server's own helper).
    const expectedSig = createHmac("sha256", WEBHOOK_SECRET)
      .update(received.rawBody, "utf8")
      .digest("hex");
    expect(received.signature).toBe(expectedSig);

    const rows = deliveryRows(app);
    expect(rows).toHaveLength(1);
    // app_id here is the internal row id ('app-row-1'); the payload carries the
    // public appId — both appear in their respective places.
    expect(rows[0]).toEqual({
      session_id: "sess-1",
      app_id: "app-row-1",
      webhook_url: sink.url,
      status: "delivered",
      attempt: 1,
      attempts_max: 3,
      response_code: 200,
      last_error: null,
    });
  });

  it("retries on non-2xx with backoff and records each attempt until success", async () => {
    const sink = await startSink([500, 503, 200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "40,40" });
    seedOtpPending(app, sink.url);
    const apiKey = await enroll(app);

    const started = Date.now();
    const res = await postResults(app, apiKey, { results: [{ id: "msg-1", status: "sent" }] });
    expect(res.statusCode).toBe(200);
    const elapsed = Date.now() - started;

    expect(sink.requests).toHaveLength(3);
    const rows = deliveryRows(app);
    expect(rows.map((r) => [r.attempt, r.status, r.response_code])).toEqual([
      [1, "failed", 500],
      [2, "failed", 503],
      [3, "delivered", 200],
    ]);
    // Two 40ms backoffs actually happened (floored for scheduling slack).
    expect(elapsed).toBeGreaterThanOrEqual(60);
  });

  it("records failure without failing the results POST when all retries are exhausted", async () => {
    const sink = await startSink([500]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    const apiKey = await enroll(app);

    const res = await postResults(app, apiKey, {
      results: [{ id: "msg-1", status: "failed", error: "radio off" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, unknown: 0 });

    expect(sink.requests).toHaveLength(3);
    const rows = deliveryRows(app);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(rows[2].attempt).toBe(3);
    // A 500 response is an HTTP outcome, not a transport error.
    expect(rows[2].last_error).toBeNull();

    // The queue state is committed regardless of webhook outcome.
    const sms = app.db.prepare("SELECT status, error FROM pending_sms WHERE id = 'msg-1'").get() as {
      status: string;
      error: string;
    };
    expect(sms).toEqual({ status: "failed", error: "radio off" });
  });

  it("sends the failed status in the payload when the phone reports failure", async () => {
    const sink = await startSink([200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    const apiKey = await enroll(app);

    await postResults(app, apiKey, {
      results: [{ id: "msg-1", status: "failed", error: "no signal" }],
    });

    expect(sink.requests).toHaveLength(1);
    expect(JSON.parse(sink.requests[0].rawBody)).toMatchObject(expectedPayload("failed"));
  });

  it("does not dispatch when the app has no webhook configured", async () => {
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, null);
    const apiKey = await enroll(app);

    const res = await postResults(app, apiKey, { results: [{ id: "msg-1", status: "sent" }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, unknown: 0 });
    expect(deliveryRows(app)).toHaveLength(0);
  });

  it("does not dispatch for accepted messages without an OTP session", async () => {
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    app.db
      .prepare(
        "INSERT INTO pending_sms (id, to_addr, message, status, created_at) " +
          "VALUES ('msg-plain', ?, ?, 'pending', unixepoch())",
      )
      .run("+8801700000009", "plain broadcast");
    const apiKey = await enroll(app);

    const res = await postResults(app, apiKey, { results: [{ id: "msg-plain", status: "sent" }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, unknown: 0 });
    expect(deliveryRows(app)).toHaveLength(0);
  });

  it("ignores unknown result ids — no dispatch, counted as unknown", async () => {
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    const apiKey = await enroll(app);

    const res = await postResults(app, apiKey, { results: [{ id: "msg-gone", status: "sent" }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 0, unknown: 1 });
    expect(deliveryRows(app)).toHaveLength(0);
  });

  it("does not re-dispatch when a terminal message is reported again", async () => {
    const sink = await startSink([200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    const apiKey = await enroll(app);

    await postResults(app, apiKey, { results: [{ id: "msg-1", status: "sent" }] });
    expect(sink.requests).toHaveLength(1);

    const res = await postResults(app, apiKey, { results: [{ id: "msg-1", status: "sent" }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 0, unknown: 1 });
    expect(sink.requests).toHaveLength(1);
  });

  it("dispatches only the OTP-linked entries of a mixed batch", async () => {
    const sink = await startSink([200, 200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    app.db
      .prepare(
        "INSERT INTO pending_sms (id, to_addr, message, status, created_at) " +
          "VALUES ('msg-plain-2', ?, ?, 'pending', unixepoch())",
      )
      .run("+8801700000009", "plain broadcast");
    const apiKey = await enroll(app);

    const res = await postResults(app, apiKey, {
      results: [
        { id: "msg-plain-2", status: "sent" },
        { id: "msg-1", status: "sent" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 2, unknown: 0 });

    expect(sink.requests).toHaveLength(1);
    expect(JSON.parse(sink.requests[0].rawBody)).toMatchObject(expectedPayload("sent"));
  });
});

/** Sends an app-authenticated OTP verify request for PHONE. */
async function postVerify(
  a: FastifyInstance,
  otp: string,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/otp/verify",
    headers: { "x-app-id": TEST_APP_ID, "x-app-secret": TEST_APP_SECRET },
    payload: { phone: PHONE, otp },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

/** Finds a loopback port with no listener — deterministic connection-refused target. */
async function findClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Points the seeded session's OTP hash at a known code (the seed uses a fake
 * constant hash) so POST /v5/otp/verify accepts `otp`.
 */
function makeVerifiable(a: FastifyInstance, otp: string): void {
  a.db
    .prepare("UPDATE otp_sessions SET otp_hash = ? WHERE id = 'sess-1'")
    .run(sha256Hex(`otp-salt${otp}`));
}

describe("POST /v5/otp/verify — verified-status webhook + dispatch logging", () => {
  it("dispatches a signed otp.status webhook with status 'verified' on successful verification", async () => {
    const sink = await startSink([200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    makeVerifiable(app, "654321");

    const res = await postVerify(app, "654321");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, verified: true });

    expect(sink.requests).toHaveLength(1);
    const received = sink.requests[0];
    const parsed = JSON.parse(received.rawBody) as Record<string, unknown>;
    expect(parsed).toMatchObject(expectedPayload("verified"));
    expect(typeof parsed.timestamp).toBe("number");

    // Independent verification: HMAC-SHA256 over the exact raw body with the
    // app's plaintext secret (not the server's own helper).
    const expectedSig = createHmac("sha256", WEBHOOK_SECRET)
      .update(received.rawBody, "utf8")
      .digest("hex");
    expect(received.signature).toBe(expectedSig);

    const rows = deliveryRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      session_id: "sess-1",
      app_id: "app-row-1",
      webhook_url: sink.url,
      status: "delivered",
      attempt: 1,
      attempts_max: 3,
      response_code: 200,
      last_error: null,
    });

    const session = app.db
      .prepare("SELECT status FROM otp_sessions WHERE id = 'sess-1'")
      .get() as { status: string };
    expect(session.status).toBe("verified");
  });

  it("does not dispatch 'verified' when the app has no webhook configured", async () => {
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, null);
    makeVerifiable(app, "654321");

    const res = await postVerify(app, "654321");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, verified: true });
    expect(deliveryRows(app)).toHaveLength(0);
  });

  it("does not dispatch when verification fails", async () => {
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, null);
    makeVerifiable(app, "654321");

    const res = await postVerify(app, "000000");
    expect(res.statusCode).toBe(401);
    expect(deliveryRows(app)).toHaveLength(0);

    const session = app.db
      .prepare("SELECT status, attempts FROM otp_sessions WHERE id = 'sess-1'")
      .get() as { status: string; attempts: number };
    expect(session.status).toBe("pending");
    expect(session.attempts).toBe(1);
  });

  it("records failed attempts with last_error populated on transport failure", async () => {
    const port = await findClosedPort();
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, `http://127.0.0.1:${port}/otp-status`);
    makeVerifiable(app, "654321");

    const res = await postVerify(app, "654321");
    // Verification must still succeed — dispatch failure is never fatal.
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, verified: true });

    const rows = deliveryRows(app);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(
      rows.every((r) => r.last_error !== null && r.last_error.length > 0),
    ).toBe(true);
    expect(rows.every((r) => r.response_code === null)).toBe(true);
  });

  it("logs a structured warn per failed attempt and an info on success", async () => {
    const sink = await startSink([500, 200]);
    cleanup.push(sink.close);
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, sink.url);
    makeVerifiable(app, "654321");

    // Capture pino events by wrapping the logger methods (pass-through so
    // normal test output is unchanged). The saved originals must be invoked
    // with the logger as `this` — pino reads instance symbols off it.
    const warnings: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const infos: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const log = app.log as unknown as {
      warn: (this: unknown, obj: unknown, msg?: string) => void;
      info: (this: unknown, obj: unknown, msg?: string) => void;
    };
    const origWarn = log.warn;
    const origInfo = log.info;
    log.warn = function (obj: unknown, msg?: string) {
      warnings.push({ obj: obj as Record<string, unknown>, msg });
      origWarn.call(this, obj, msg);
    };
    log.info = function (obj: unknown, msg?: string) {
      infos.push({ obj: obj as Record<string, unknown>, msg });
      origInfo.call(this, obj, msg);
    };

    const res = await postVerify(app, "654321");
    expect(res.statusCode).toBe(200);

    // Attempt 1 (500) → warn with status code and attempt number; attempt 2
    // (200) → info with the same correlation fields.
    expect(
      warnings.some(
        (w) =>
          w.msg?.includes("non-2xx") &&
          w.obj.attempt === 1 &&
          w.obj.responseCode === 500 &&
          w.obj.sessionId === "sess-1",
      ),
    ).toBe(true);
    expect(
      infos.some(
        (i) =>
          i.msg?.includes("succeeded") &&
          i.obj.attempt === 2 &&
          i.obj.responseCode === 200,
      ),
    ).toBe(true);
  });

  it("logs the error object for transport failures", async () => {
    const port = await findClosedPort();
    app = makeApp({ WEBHOOK_RETRY_DELAYS_MS: "10,10" });
    seedOtpPending(app, `http://127.0.0.1:${port}/otp-status`);
    makeVerifiable(app, "654321");

    const warnings: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const log = app.log as unknown as {
      warn: (this: unknown, obj: unknown, msg?: string) => void;
    };
    const origWarn = log.warn;
    log.warn = function (obj: unknown, msg?: string) {
      warnings.push({ obj: obj as Record<string, unknown>, msg });
      origWarn.call(this, obj, msg);
    };

    await postVerify(app, "654321");

    expect(
      warnings.some(
        (w) =>
          w.msg?.includes("transport error") &&
          w.obj.err instanceof Error &&
          w.obj.attempt === 1,
      ),
    ).toBe(true);
  });
});
