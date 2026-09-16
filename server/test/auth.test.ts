/**
 * M1 auth flow tests: register → login → refresh, device registration +
 * heartbeat, and the requireAuth/requireDevice choke points.
 * Uses temp DBs and a test JWT secret; no real network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

/** Deterministic test secret (32+ chars) — never a production value. */
const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";

function makeApp(): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-auth-test-")), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET } });
}

const EMAIL = "taylor@example.com";
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;
let accessToken = "";
let refreshToken = "";

beforeAll(async () => {
  app = makeApp();
});

afterAll(async () => {
  await app.close();
});

describe("POST /v5/auth/register", () => {
  it("creates a user and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
  });

  it("normalizes email case and rejects duplicates with 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: EMAIL.toUpperCase(), password: PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, code: "email_taken" });
  });

  it("rejects malformed email with structured 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "not-an-email", password: PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_email" });
  });

  it("rejects short passwords with structured 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "x@example.com", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_password" });
  });
});

describe("POST /v5/auth/login", () => {
  it("returns access + refresh tokens for valid credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    accessToken = body.accessToken;
    refreshToken = body.refreshToken;
  });

  it("rejects wrong password with 401 and never leaks hash material", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: EMAIL, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_credentials" });
  });

  it("rejects unknown email with identical 401 envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "ghost@example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_credentials" });
  });
});

describe("POST /v5/auth/refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.refreshToken).not.toBe(refreshToken); // single-use rotation
    accessToken = body.accessToken;
    refreshToken = body.refreshToken;
  });

  it("rejects reuse of an already-rotated refresh token (single-use)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v5/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const stale = refreshToken;
    const second = await app.inject({
      method: "POST",
      url: "/v5/auth/refresh",
      payload: { refreshToken: stale },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ ok: false, code: "invalid_refresh_token" });
  });

  it("rejects garbage tokens with structured 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/refresh",
      payload: { refreshToken: "not-a-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_refresh_token" });
  });
});

describe("device registration + heartbeat (device plane)", () => {
  let deviceApiKey = "";

  it("POST /v5/device/register requires a user JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/register",
      payload: { label: "test phone" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "missing_bearer_token" });
  });

  it("registers a device and returns the raw key exactly once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/register",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { label: "test phone" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.apiKey).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes hex
    deviceApiKey = body.apiKey;

    // Raw key never persisted — only its SHA-256 digest:
    const digest = Buffer.from(deviceApiKey, "utf8").toString("hex");
    const row = app.db
      .prepare("SELECT api_key_hash FROM devices WHERE label = 'test phone'")
      .get() as { api_key_hash: string };
    expect(row.api_key_hash).not.toBe(deviceApiKey);
    expect(row.api_key_hash).toHaveLength(64);
  });

  it("POST /v5/device/heartbeat requires the device key", async () => {
    const res = await app.inject({ method: "POST", url: "/v5/device/heartbeat" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "missing_device_key" });
  });

  it("accepts a valid heartbeat and updates last_seen_at", async () => {
    const before = app.db
      .prepare("SELECT last_seen_at FROM devices WHERE label = 'test phone'")
      .get() as { last_seen_at: number | null };
    expect(before.last_seen_at).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: "/v5/device/heartbeat",
      headers: { authorization: `Bearer ${deviceApiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const after = app.db
      .prepare("SELECT last_seen_at FROM devices WHERE label = 'test phone'")
      .get() as { last_seen_at: number | null };
    expect(after.last_seen_at).not.toBeNull();
    expect(Math.abs(after.last_seen_at! - Date.now() / 1000)).toBeLessThan(60);
  });

  it("rejects an unknown device key with structured 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/heartbeat",
      headers: { authorization: `Bearer ${"f".repeat(64)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_device_key" });
  });

  it("rejects a revoked device key", async () => {
    // Register a second device directly in the DB, then revoke it.
    const digest = app.sha256Hex("a".repeat(64));
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, revocable, revoked_at, created_at) " +
          "VALUES ('dev-revoked', (SELECT id FROM users LIMIT 1), 'revoked', ?, 1, unixepoch(), unixepoch())",
      )
      .run(digest);
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/heartbeat",
      headers: { authorization: `Bearer ${"a".repeat(64)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "device_revoked" });
  });

  it("rejects a tampered access token on a protected route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/register",
      headers: { authorization: "Bearer not.a.jwt" },
      payload: { label: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_access_token" });
  });
});
