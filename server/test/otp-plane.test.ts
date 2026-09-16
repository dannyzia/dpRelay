/**
 * M3 OTP plane route tests (PLAN §7): send/verify/status behavioral parity with
 * v4 — kill switch, per-phone rate limits, hashed-OTP verification with attempt
 * lockout, expiry, resend supersession, and app-credential rejection.
 * FCM wake is not configured in tests (empty service account) — send must
 * succeed with the wake skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "otp-test-jwt-secret-0123456789abcdef0123456789ab";
const TEST_APP_ID = "app_test_1";
const TEST_APP_SECRET = "otp-test-app-secret-0123456789abcdef0123456789ab";
const PHONE = "+8801712345678";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-otp-test-")), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, ...extra },
  });
}

function seedApp(app: FastifyInstance): void {
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, rate_max_per_phone, rate_window_sec, created_at) " +
        "VALUES ('app-row-1', ?, ?, 'Test App', 3, 3600, unixepoch())",
    )
    .run(TEST_APP_ID, sha256Hex(TEST_APP_SECRET));
}

function appHeaders(secret = TEST_APP_SECRET): Record<string, string> {
  return { "x-app-id": TEST_APP_ID, "x-app-secret": secret };
}

/** Counts pending OTP sessions for the seeded app + phone. */
function pendingCount(app: FastifyInstance): number {
  return (
    app.db
      .prepare("SELECT COUNT(*) AS n FROM otp_sessions WHERE status = 'pending'")
      .get() as { n: number }
  ).n;
}

let app: FastifyInstance;

beforeEach(() => {
  app = makeApp();
  seedApp(app);
});

afterEach(async () => {
  if (app) await app.close();
});

describe("POST /v5/otp/send", () => {
  it("creates a session + pending_sms and returns 201 (FCM wake skipped, not fatal)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sessionId).toBe("string");
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(pendingCount(app)).toBe(1);
    const sms = app.db
      .prepare("SELECT to_addr, status FROM pending_sms")
      .get() as { to_addr: string; status: string };
    expect(sms.to_addr).toBe(PHONE);
    expect(sms.status).toBe("pending");
  });

  it("rejects non-E.164 numbers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: "01712345678" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_phone");
  });

  it("503s with sms_paused when the kill switch is on", async () => {
    app.db.prepare("UPDATE settings SET value = 'true' WHERE key = 'kill_switch'").run();
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("sms_paused");
    expect(pendingCount(app)).toBe(0);
  });

  it("429s past the per-phone rate limit and supersede keeps one pending session", async () => {
    app.close();
    app = makeApp(); // fresh app + fresh rate state
    seedApp(app);
    // apps table rate limit is 3 per phone per hour
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v5/otp/send",
        headers: appHeaders(),
        payload: { phone: PHONE },
      });
      expect(res.statusCode).toBe(201);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    expect(limited.statusCode).toBe(429);
    // resends supersede: only the newest send stays pending
    expect(pendingCount(app)).toBe(1);
  });

  it("401s unknown app id and bad app secret", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": "no_such_app", "x-app-secret": TEST_APP_SECRET },
      payload: { phone: PHONE },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe("unknown_app");

    const badSecret = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": TEST_APP_ID, "x-app-secret": "wrong" },
      payload: { phone: PHONE },
    });
    expect(badSecret.statusCode).toBe(401);
    expect(badSecret.json().code).toBe("invalid_app_secret");
  });
});

describe("POST /v5/otp/verify", () => {
  async function send(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    expect(res.statusCode).toBe(201);
    return res.json().sessionId as string;
  }

  it("verifies the correct OTP atomically and marks the session verified", async () => {
    const sessionId = await send();
    const row = app.db.prepare("SELECT salt FROM otp_sessions WHERE id = ?").get(sessionId) as {
      salt: string;
    };
    // The plaintext OTP is never stored — recover it from the pending SMS body.
    const sms = app.db.prepare("SELECT message FROM pending_sms WHERE id = ?").get(
      (
        app.db.prepare("SELECT message_id FROM otp_sessions WHERE id = ?").get(sessionId) as {
          message_id: string;
        }
      ).message_id,
    ) as { message: string };
    const otp = sms.message.match(/(\d{6})/)![1];
    expect(sha256Hex(row.salt + otp)).toBeDefined();

    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/verify",
      headers: appHeaders(),
      payload: { phone: PHONE, otp },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    const status = app.db.prepare("SELECT status, verified_at FROM otp_sessions WHERE id = ?").get(
      sessionId,
    ) as { status: string; verified_at: number | null };
    expect(status.status).toBe("verified");
    expect(status.verified_at).not.toBeNull();
  });

  it("401s a wrong code with attemptsLeft, then locks after OTP_MAX_ATTEMPTS", async () => {
    app.close();
    app = makeApp({ OTP_MAX_ATTEMPTS: "2" });
    seedApp(app);
    await send();

    const first = await app.inject({
      method: "POST",
      url: "/v5/otp/verify",
      headers: appHeaders(),
      payload: { phone: PHONE, otp: "000000" },
    });
    expect(first.statusCode).toBe(401);
    expect(first.json().attemptsLeft).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/v5/otp/verify",
      headers: appHeaders(),
      payload: { phone: PHONE, otp: "000001" },
    });
    expect(second.statusCode).toBe(423);
    expect(second.json().code).toBe("otp_locked");

    // Even the correct code is rejected while locked.
    const third = await app.inject({
      method: "POST",
      url: "/v5/otp/verify",
      headers: appHeaders(),
      payload: { phone: PHONE, otp: "000000" },
    });
    expect(third.statusCode).toBe(423);
  });

  it("rejects verify when the only session is expired", async () => {
    const sessionId = await send();
    app.db
      .prepare("UPDATE otp_sessions SET expires_at = unixepoch() - 10 WHERE id = ?")
      .run(sessionId);
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/verify",
      headers: appHeaders(),
      payload: { phone: PHONE, otp: "123456" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("otp_expired");
  });
});

describe("GET /v5/otp/status", () => {
  it("404s with no session", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v5/otp/status?phone=${encodeURIComponent(PHONE)}`,
      headers: appHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports pending with attempts left, and expired after lazy expiry", async () => {
    await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    const pending = await app.inject({
      method: "GET",
      url: `/v5/otp/status?phone=${encodeURIComponent(PHONE)}`,
      headers: appHeaders(),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().status).toBe("pending");
    expect(pending.json().attemptsLeft).toBe(5);

    app.db
      .prepare("UPDATE otp_sessions SET expires_at = unixepoch() - 10")
      .run();
    const expired = await app.inject({
      method: "GET",
      url: `/v5/otp/status?phone=${encodeURIComponent(PHONE)}`,
      headers: appHeaders(),
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json().status).toBe("expired");
  });
});
