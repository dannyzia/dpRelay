/**
 * ISSUE-119 — hard email-gated verification: provisioning (POST
 * /v5/auth/companies, POST /v5/auth/apps) and live dispatch (requireApp)
 * fail closed with 403 email_verification_required when mail is configured
 * and the account is unverified. Unconfigured mail (local dev/test),
 * verified accounts, and operator-provisioned apps (NULL owner) pass through.
 *
 * Own file (not auth-email.test.ts) on purpose: the customer-auth rate limit
 * is counted per test process, and this file registers one user per test —
 * following the companies.test.ts precedent of a fresh counter.
 *
 * Temp DBs + app.inject: no real network (registration never reaches SMTP
 * without DASHBOARD_BASE_URL), no shared state between tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance, InjectOptions } from "fastify";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "correct-horse-battery";
const PHONE = "+8801712345678";

let app: FastifyInstance;

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-email-gating-test-"), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, ...env },
  });
}

afterEach(async () => {
  if (app) await app.close();
});

/** Seeds a configured SMTP row directly (routes' PUT is covered elsewhere). */
function seedMailConfig(): void {
  app.db
    .prepare(
      "INSERT INTO mail_config (id, host, port, username, password_encrypted, from_address, updated_at) " +
        "VALUES (1, 'smtp.example.test', 465, 'u@example.test', 'v1:aaaa:bbbb:cccc', 'f@example.test', unixepoch()) " +
        "ON CONFLICT(id) DO NOTHING",
    )
    .run();
}

/** Extracts the dp_session cookie value from a Set-Cookie header list. */
function sessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = list.map((c) => /(?:^|;\s*)dp_session=([^;]*)/.exec(c)).find((m) => m !== null);
  if (!match) throw new Error(`no dp_session cookie in Set-Cookie: ${JSON.stringify(list)}`);
  return match[1];
}

/** Registers a fresh (unverified) user and returns its session cookie. */
async function registerUser(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/auth/register",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res.headers["set-cookie"]);
}

function authed(cookie: string, opts: InjectOptions = {}): InjectOptions {
  return { ...opts, headers: { ...(opts.headers ?? {}), cookie: `dp_session=${cookie}` } };
}

/** Resolves the user id behind a session cookie via GET /v5/auth/me. */
async function userIdFor(a: FastifyInstance, cookie: string): Promise<string> {
  const res = await a.inject(authed(cookie, { method: "GET", url: "/v5/auth/me" }));
  expect(res.statusCode).toBe(200);
  return (res.json() as { user: { id: string } }).user.id;
}

/** Creates a company via the session route and returns its identifiers. */
async function createCompany(
  a: FastifyInstance,
  cookie: string,
  name: string,
): Promise<{ companyId: string; appId: string; appSecret: string }> {
  const res = await a.inject(authed(cookie, { method: "POST", url: "/v5/auth/companies", payload: { name } }));
  expect(res.statusCode).toBe(201);
  const body = res.json() as { company: { id: string }; app: { appId: string; appSecret: string } };
  return { companyId: body.company.id, appId: body.app.appId, appSecret: body.app.appSecret };
}

describe("ISSUE-119 provisioning gate", () => {
  it("403s company creation for unverified accounts when mail is configured", async () => {
    app = makeApp();
    seedMailConfig();
    const cookie = await registerUser(app, "unverified-co@example.test");
    const res = await app.inject(authed(cookie, { method: "POST", url: "/v5/auth/companies", payload: { name: "Shop" } }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      ok: false,
      error: "Email verification required before creating apps or credentials",
      code: "email_verification_required",
    });
  });

  it("403s self-serve app registration for unverified accounts when mail is configured", async () => {
    app = makeApp();
    seedMailConfig();
    const cookie = await registerUser(app, "unverified-app@example.test");
    const res = await app.inject(authed(cookie, { method: "POST", url: "/v5/auth/apps", payload: {} }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      ok: false,
      error: "Email verification required before creating apps or credentials",
      code: "email_verification_required",
    });
  });

  it("lets unverified accounts provision when mail is unconfigured (dev/test bypass)", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "bypass-co@example.test");
    const res = await app.inject(authed(cookie, { method: "POST", url: "/v5/auth/companies", payload: { name: "Shop" } }));
    expect(res.statusCode).toBe(201);
  });

  it("lets verified accounts provision when mail is configured", async () => {
    app = makeApp();
    seedMailConfig();
    const cookie = await registerUser(app, "verified-co@example.test");
    const userId = await userIdFor(app, cookie);
    app.db.prepare("UPDATE users SET email_verified_at = unixepoch() WHERE id = ?").run(userId);
    const res = await app.inject(authed(cookie, { method: "POST", url: "/v5/auth/companies", payload: { name: "Shop" } }));
    expect(res.statusCode).toBe(201);
    expect((res.json() as { company: { name: string } }).company.name).toBe("Shop");
  });
});

describe("ISSUE-119 dispatch gate (requireApp)", () => {
  it("403s live sends for customer-owned apps whose owner is unverified when mail is configured", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "unverified-sender@example.test");
    // Provision while mail is off, then turn mail on — the app is now live
    // but its owner never verified.
    const created = await createCompany(app, cookie, "Sender Co");
    seedMailConfig();
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": created.appId, "x-app-secret": created.appSecret },
      payload: { phone: PHONE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      ok: false,
      error: "Account email is unverified. Verify your email to send messages.",
      code: "email_verification_required",
    });
    // Fail-closed before any session or ledger write.
    const pending = (app.db.prepare("SELECT COUNT(*) AS n FROM otp_sessions").get() as { n: number }).n;
    expect(pending).toBe(0);
  });

  it("sends for verified owners when mail is configured (trial covers the first SMS)", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "verified-sender@example.test");
    const created = await createCompany(app, cookie, "Sender Co");
    const userId = await userIdFor(app, cookie);
    app.db.prepare("UPDATE users SET email_verified_at = unixepoch() WHERE id = ?").run(userId);
    seedMailConfig();
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": created.appId, "x-app-secret": created.appSecret },
      payload: { phone: PHONE },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it("operator-provisioned apps (NULL owner) keep sending with mail configured", async () => {
    app = makeApp();
    const secret = "operator-test-secret-0123456789abcdef0123456789ab";
    app.db
      .prepare(
        "INSERT INTO apps (id, app_id, app_secret_hash, name, rate_max_per_phone, rate_window_sec, created_at) " +
          "VALUES ('app-row-op', 'app_operator_1', ?, 'Operator App', 3, 3600, unixepoch())",
      )
      .run(sha256Hex(secret));
    app.db
      .prepare("INSERT INTO app_credits (app_id, otp_sms_remaining, updated_at) VALUES ('app-row-op', 1000, unixepoch())")
      .run();
    seedMailConfig();
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": "app_operator_1", "x-app-secret": secret },
      payload: { phone: PHONE },
    });
    expect(res.statusCode).toBe(201);
  });
});
