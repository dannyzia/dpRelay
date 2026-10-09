/**
 * STAGE F3 (ISSUE-81) customer-auth tests: register/login/logout/me session
 * flow, self-serve app registration with the one-time trial grant, and the
 * operator-app link route. Also locks the additive-hybrid contract: the M1 JWT
 * response shapes stay intact alongside the new session cookie.
 * Uses temp DBs, an injected env, and app.inject — no real network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance, InjectOptions } from "fastify";

/** Deterministic test secret (32+ chars) — never a production value. */
const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const TEST_PROVISIONING_SECRET = "test-provisioning-secret-0123456789abcdef";

let app: FastifyInstance;

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-auth-session-test-")), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      APP_PROVISIONING_SECRET: TEST_PROVISIONING_SECRET,
      TRIAL_SMS_COUNT: "7",
      TRIAL_SMS_TTL_DAYS: "14",
      ...env,
    },
  });
}

/** Extracts the dp_session cookie value from a Set-Cookie header list. */
function sessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = list.map((c) => /(?:^|;\s*)dp_session=([^;]*)/.exec(c)).find((m) => m !== null);
  if (!match) throw new Error(`no dp_session cookie in Set-Cookie: ${JSON.stringify(list)}`);
  return match[1];
}

/** Registers + returns the session cookie for a fresh user. */
async function registerUser(email: string, password = "correct-horse-battery"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v5/auth/register", payload: { email, password } });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res.headers["set-cookie"]);
}

function authed(cookie: string, opts: InjectOptions = {}): InjectOptions {
  return { ...opts, headers: { ...(opts.headers ?? {}), cookie: `dp_session=${cookie}` } };
}

beforeAll(async () => {
  app = makeApp();
});

afterAll(async () => {
  await app.close();
});

describe("POST /v5/auth/register (F3 additive-hybrid)", () => {
  it("creates the user, stores a scrypt hash, sets the session cookie, keeps the M1 envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "f3-user@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });

    const cookie = res.headers["set-cookie"] as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(sessionCookie(res.headers["set-cookie"])).not.toHaveLength(0);

    const row = app.db
      .prepare("SELECT password_hash FROM users WHERE email = ?")
      .get("f3-user@example.com") as { password_hash: string };
    expect(row.password_hash.startsWith("scrypt:N=32768,r=8,p=1:")).toBe(true);
  });

  it("rejects a 9-char password with 400 invalid_password (minimum is 10)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "short-pass@example.com", password: "a".repeat(9) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "invalid_password" });
  });

  it("treats case-variant duplicates as taken (normalized unique email)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "dup-check@example.com", password: "correct-horse-battery" },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "  DUP-CHECK@EXAMPLE.COM ", password: "another-passphrase" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ ok: false, code: "email_taken" });
  });
});

describe("POST /v5/auth/login + GET /v5/auth/me (F3 session)", () => {
  it("logs in a scrypt user, sets the cookie, and preserves the M1 JWT pair", async () => {
    await registerUser("login-user@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "login-user@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // Legacy contract preserved: tokens still minted for dashboard/ + web/.
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(sessionCookie(res.headers["set-cookie"])).not.toHaveLength(0);

    const me = await app.inject(authed(sessionCookie(res.headers["set-cookie"]), { url: "/v5/auth/me" }));
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ ok: true, user: { email: "login-user@example.com" } });
  });

  it("still accepts an Argon2-era user (M1 hash) through the same login", async () => {
    // Simulate a pre-F3 row: Argon2 PHC hash written by the M1 flow.
    const { hashPassword } = await import("../src/services/crypto.js");
    const argonHash = await hashPassword("legacy-argon2-password");
    app.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, unixepoch())")
      .run("legacy-user-1", "legacy@example.com", argonHash);
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "legacy@example.com", password: "legacy-argon2-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(sessionCookie(res.headers["set-cookie"])).not.toHaveLength(0);
  });

  it("returns one generic envelope for wrong password and unknown email", async () => {
    await registerUser("generic-check@example.com");
    const wrong = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "generic-check@example.com", password: "wrong-password-xyz" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "ghost-f3@example.com", password: "wrong-password-xyz" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toMatchObject({ code: "invalid_credentials" });
    expect(JSON.stringify(wrong.json())).not.toContain("$argon2");
  });

  it("rejects disabled accounts with the same generic envelope and kills their live session", async () => {
    const cookie = await registerUser("disabled-user@example.com");
    const alive = await app.inject(authed(cookie, { url: "/v5/auth/me" }));
    expect(alive.statusCode).toBe(200);
    app.db.prepare("UPDATE users SET disabled = 1 WHERE email = ?").run("disabled-user@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "disabled-user@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({ code: "invalid_credentials" });
    const me = await app.inject(authed(cookie, { url: "/v5/auth/me" }));
    expect(me.statusCode).toBe(401);
    expect(me.json()).toMatchObject({ code: "auth_required" });
  });

  it("401s /v5/auth/me without a cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/v5/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, code: "auth_required" });
  });

  it("expires a session once its row does", async () => {
    const cookie = await registerUser("expiry-user@example.com");
    app.db
      .prepare(
        "UPDATE user_sessions SET expires_at = (SELECT unixepoch() FROM user_sessions LIMIT 1) - 1 " +
          "WHERE user_id = (SELECT id FROM users WHERE email = 'expiry-user@example.com')",
      )
      .run();
    const me = await app.inject(authed(cookie, { url: "/v5/auth/me" }));
    expect(me.statusCode).toBe(401);
    const remaining = app.db
      .prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)")
      .get("expiry-user@example.com") as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe("POST /v5/auth/logout", () => {
  it("deletes the session row and expires the cookie; idempotent without a cookie", async () => {
    const cookie = await registerUser("logout-user@example.com");
    const out = await app.inject(authed(cookie, { method: "POST", url: "/v5/auth/logout" }));
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(out.headers["set-cookie"]).toContain("Max-Age=0");
    const me = await app.inject(authed(cookie, { url: "/v5/auth/me" }));
    expect(me.statusCode).toBe(401);
    const again = await app.inject({ method: "POST", url: "/v5/auth/logout" });
    expect(again.statusCode).toBe(200);
  });
});

describe("POST/GET /v5/auth/apps (self-serve registration)", () => {
  it("mints owned app credentials, applies the trial grant atomically, never re-serves secrets", async () => {
    const cookie = await registerUser("app-owner@example.com");
    const res = await app.inject(
      authed(cookie, { method: "POST", url: "/v5/auth/apps", payload: { name: "My Shop" } }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.appId).toMatch(/^app_[A-Za-z0-9_-]+$/);
    expect(body.appSecret.length).toBeGreaterThanOrEqual(32);
    expect(body.name).toBe("My Shop");
    expect(body.trial).toMatchObject({ otpSms: 7, bulkSms: 7 });

    const row = app.db
      .prepare(
        "SELECT a.owner_user_id, a.app_secret_hash, c.otp_sms_remaining, c.bulk_sms_remaining, " +
          "c.otp_expires_at, c.bulk_expires_at FROM apps a JOIN app_credits c ON c.app_id = a.id " +
          "WHERE a.app_id = ?",
      )
      .get(body.appId) as {
      owner_user_id: string;
      app_secret_hash: string;
      otp_sms_remaining: number;
      bulk_sms_remaining: number;
      otp_expires_at: number;
      bulk_expires_at: number;
    };
    const user = app.db.prepare("SELECT id FROM users WHERE email = ?").get("app-owner@example.com") as {
      id: string;
    };
    expect(row.owner_user_id).toBe(user.id);
    expect(row.app_secret_hash).not.toContain(body.appSecret);
    expect(row.otp_sms_remaining).toBe(7);
    expect(row.bulk_sms_remaining).toBe(7);
    const expectedExpiry = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
    expect(Math.abs(row.otp_expires_at - expectedExpiry)).toBeLessThanOrEqual(5);
    expect(row.bulk_expires_at).toBe(row.otp_expires_at);

    // Secrets ONCE: the owned-apps list carries no credential material at all.
    const list = await app.inject(authed(cookie, { url: "/v5/auth/apps" }));
    expect(list.statusCode).toBe(200);
    expect(list.json().apps).toEqual([
      { appId: body.appId, name: "My Shop", revoked: false, createdAt: expect.any(Number) },
    ]);
    expect(JSON.stringify(list.json())).not.toContain(body.appSecret);

    // The minted credentials are LIVE on the app plane (requireApp accepts them).
    const credits = await app.inject({
      method: "GET",
      url: "/v5/billing/credits",
      headers: { "x-app-id": body.appId, "x-app-secret": body.appSecret },
    });
    expect(credits.statusCode).toBe(200);
    expect(credits.json().credits.otpSmsRemaining).toBe(7);
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "POST", url: "/v5/auth/apps", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "auth_required" });
  });

  it("scopes the list to the session user", async () => {
    const cookieA = await registerUser("scoped-a@example.com");
    const cookieB = await registerUser("scoped-b@example.com");
    const madeB = await app.inject(authed(cookieB, { method: "POST", url: "/v5/auth/apps", payload: {} }));
    expect(madeB.statusCode).toBe(201);
    const listA = await app.inject(authed(cookieA, { url: "/v5/auth/apps" }));
    expect(listA.json().apps).toEqual([]);
    const listB = await app.inject(authed(cookieB, { url: "/v5/auth/apps" }));
    expect(listB.json().apps).toHaveLength(1);
  });
});

describe("POST /v5/auth/apps/link (operator-provisioned claim)", () => {
  it("claims a NULL-owner app, is idempotent for the owner, and rejects everyone else", async () => {
    // Operator-provisioned app (NULL owner) via the existing M4 route.
    const provisioned = await app.inject({
      method: "POST",
      url: "/v5/apps/register",
      headers: { authorization: `Bearer ${TEST_PROVISIONING_SECRET}` },
      payload: { appId: "haven-test-app", appSecret: "haven-test-secret-0123456789abcdef", name: "Haven" },
    });
    expect(provisioned.statusCode).toBe(201);

    const claimer = await registerUser("linker-a@example.com");
    const rival = await registerUser("linker-b@example.com");

    // Wrong secret and unknown appId share one envelope (no enumeration).
    const wrongSecret = await app.inject(
      authed(claimer, {
        method: "POST",
        url: "/v5/auth/apps/link",
        payload: { appId: "haven-test-app", appSecret: "not-the-secret-0123456789abcdef" },
      }),
    );
    const unknownApp = await app.inject(
      authed(claimer, {
        method: "POST",
        url: "/v5/auth/apps/link",
        payload: { appId: "no-such-app-id", appSecret: "haven-test-secret-0123456789abcdef" },
      }),
    );
    expect(wrongSecret.statusCode).toBe(401);
    expect(unknownApp.statusCode).toBe(401);
    expect(wrongSecret.json()).toEqual(unknownApp.json());

    // Claim binds ownership to the prover.
    const claim = await app.inject(
      authed(claimer, {
        method: "POST",
        url: "/v5/auth/apps/link",
        payload: { appId: "haven-test-app", appSecret: "haven-test-secret-0123456789abcdef" },
      }),
    );
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ ok: true, appId: "haven-test-app", name: "Haven", revoked: false });
    const owner = app.db
      .prepare("SELECT owner_user_id FROM apps WHERE app_id = ?")
      .get("haven-test-app") as { owner_user_id: string };
    const claimerRow = app.db.prepare("SELECT id FROM users WHERE email = ?").get("linker-a@example.com") as {
      id: string;
    };
    expect(owner.owner_user_id).toBe(claimerRow.id);

    // The linked app now shows in the owner's list — still without secrets.
    const list = await app.inject(authed(claimer, { url: "/v5/auth/apps" }));
    expect(list.json().apps.map((a: { appId: string }) => a.appId)).toContain("haven-test-app");

    // Idempotent re-prove (fresh-tab recovery path).
    const reprove = await app.inject(
      authed(claimer, {
        method: "POST",
        url: "/v5/auth/apps/link",
        payload: { appId: "haven-test-app", appSecret: "haven-test-secret-0123456789abcdef" },
      }),
    );
    expect(reprove.statusCode).toBe(200);

    // A different signed-in user cannot steal the claimed app — but a NULL-owner
    // app with correct credentials is claimable, so the envelope above stays
    // honest. Here the app is owned, so: 409.
    const rivalLink = await app.inject(
      authed(rival, {
        method: "POST",
        url: "/v5/auth/apps/link",
        payload: { appId: "haven-test-app", appSecret: "haven-test-secret-0123456789abcdef" },
      }),
    );
    expect(rivalLink.statusCode).toBe(409);
    expect(rivalLink.json()).toMatchObject({ code: "app_already_linked" });
  });

  it("rejects linking a revoked app after proof", async () => {
    const provisioned = await app.inject({
      method: "POST",
      url: "/v5/apps/register",
      headers: { authorization: `Bearer ${TEST_PROVISIONING_SECRET}` },
      payload: { appId: "revoked-link-app", appSecret: "revoked-link-secret-0123456789abcdef" },
    });
    expect(provisioned.statusCode).toBe(201);
    app.db.prepare("UPDATE apps SET revoked_at = unixepoch() WHERE app_id = ?").run("revoked-link-app");
    const cookie = await registerUser("revoked-linker@example.com");
    const res = await app.inject(
      authed(cookie, {
        method: "POST",
        url: "/v5/auth/apps/link",
        payload: { appId: "revoked-link-app", appSecret: "revoked-link-secret-0123456789abcdef" },
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "app_revoked" });
  });

  it("requires a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/apps/link",
      payload: { appId: "x", appSecret: "y" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "auth_required" });
  });
});

describe("customer-auth rate limit (per IP)", () => {
  it("429s with Retry-After once the sliding window is exhausted", async () => {
    const limited = makeApp({ AUTH_RATE_MAX_PER_HOUR: "5", AUTH_RATE_WINDOW_SEC: "3600" });
    try {
      const email = "brute-force@example.com";
      await limited.inject({ method: "POST", url: "/v5/auth/register", payload: { email, password: "correct-horse-battery" } });
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await limited.inject({
          method: "POST",
          url: "/v5/auth/login",
          payload: { email, password: "definitely-not-the-password" },
        });
        codes.push(res.statusCode);
        if (res.statusCode === 429) {
          expect(res.headers["retry-after"]).toBeDefined();
          expect(res.json()).toMatchObject({ code: "rate_limited" });
        }
      }
      // 5 attempts fit the window (register consumed one, logins consume the rest);
      // by the 6th call the window must be refusing.
      expect(codes).toContain(429);
      expect(codes.filter((c) => c === 401).length).toBeGreaterThanOrEqual(4);
    } finally {
      await limited.close();
    }
  });
});

describe("M1 contract preservation (additive-hybrid regression)", () => {
  it("refresh still rotates a token pair issued by the hybrid login", async () => {
    await registerUser("m1-legacy@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "m1-legacy@example.com", password: "correct-horse-battery" },
    });
    const { refreshToken } = login.json();
    const refreshed = await app.inject({
      method: "POST",
      url: "/v5/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(typeof refreshed.json().accessToken).toBe("string");
    expect(refreshed.json().refreshToken).not.toBe(refreshToken);
  });
});
