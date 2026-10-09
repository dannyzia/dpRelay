/**
 * STAGE F5 (ISSUE-83): user withhold.
 * Ordered invariants: POST /v5/admin/users/:id/disable + /enable (operator
 * gated); withheld = login blocked (generic 401, anti-enumeration), session
 * resolution rejected, app-plane sends rejected with the DISTINCT
 * account_withheld code; balances are NEVER touched by withhold; an
 * operator-provisioned app (owner NULL) is unaffected; enable restores.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "withhold-test-jwt-0123456789abcdef0123456789abcdef";
const OPERATOR = "withhold-operator-secret-0123456789abcdef";
const EMAIL = "withhold@example.test";
const PASSWORD = "correct-horse-battery-1";

let app: FastifyInstance;
let userId: string;
let ownedAppId: string; // apps.id (internal)
let ownedCred: Record<string, string>;
let cookie: string;

/** Direct-inserts an operator-provisioned app (owner NULL) with credits. */
function seedOperatorApp(appId: string, secret: string): { id: string; cred: Record<string, string> } {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(id, appId, sha256Hex(secret), appId);
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, otp_sms_remaining, updated_at) VALUES (?, 50, unixepoch())",
    )
    .run(id);
  return { id, cred: { "x-app-id": appId, "x-app-secret": secret } };
}

/** Forces a deterministic credit balance on an app (trial grant is config-dependent). */
function forceCredits(appRowId: string, otp: number): void {
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, otp_sms_remaining, updated_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(app_id) DO UPDATE SET otp_sms_remaining = excluded.otp_sms_remaining, otp_expires_at = NULL",
    )
    .run(appRowId, otp);
}

function otpRemaining(appRowId: string): number {
  const row = app.db
    .prepare("SELECT otp_sms_remaining FROM app_credits WHERE app_id = ?")
    .get(appRowId) as { otp_sms_remaining: number } | undefined;
  return row?.otp_sms_remaining ?? -1;
}

function op(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${OPERATOR}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function sendOtp(cred: Record<string, string>, phone: string) {
  return app.inject({ method: "POST", url: "/v5/otp/send", headers: cred, payload: { phone } });
}

beforeEach(async () => {
  app = buildApp({
    dbPath: join(mkdtempSync(join(tmpdir(), "dprelay-withhold-test-")), "test.db"),
    env: { JWT_SECRET: TEST_JWT_SECRET, OPERATOR_SECRET: OPERATOR },
  });

  // Register a real customer and create a self-serve owned app (F3 plane).
  const reg = await app.inject({
    method: "POST",
    url: "/v5/auth/register",
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(reg.statusCode).toBe(201);
  const setCookie = reg.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  cookie = raw.split(";")[0];

  const created = await app.inject({
    method: "POST",
    url: "/v5/auth/apps",
    headers: { cookie },
    payload: { name: "withhold-target" },
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as { appId: string; appSecret: string };
  ownedCred = { "x-app-id": body.appId, "x-app-secret": body.appSecret };
  const row = app.db.prepare("SELECT id FROM apps WHERE app_id = ?").get(body.appId) as { id: string };
  ownedAppId = row.id;
  forceCredits(ownedAppId, 50);

  const user = app.db.prepare("SELECT id FROM users WHERE email = ?").get(EMAIL) as { id: string };
  userId = user.id;
});

afterEach(async () => {
  await app.close();
});

describe("user withhold lifecycle", () => {
  it("disable blocks login + sessions + sends (account_withheld) without touching credits; enable restores", async () => {
    // Baseline send works and deducts one credit.
    const before = await sendOtp(ownedCred, "+8801555000001");
    expect(before.statusCode).toBe(201);
    expect(otpRemaining(ownedAppId)).toBe(49);

    // Directory shows the user and their app, un-withheld.
    const list = (await op("GET", "/v5/admin/users")).json() as {
      users: { id: string; email: string; disabled: boolean; appCount: number; apps: { id: string }[] }[];
    };
    const me = list.users.find((u) => u.id === userId);
    expect(me).toMatchObject({ email: EMAIL, disabled: false, appCount: 1 });
    expect(me?.apps.map((a) => a.id)).toEqual([ownedAppId]);

    // Withhold.
    const disable = await op("POST", `/v5/admin/users/${userId}/disable`);
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ ok: true, disabled: true });

    // Login blocked — generic envelope (anti-enumeration: no disabled flag leaks).
    const login = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().ok).toBe(false);
    expect(JSON.stringify(login.json())).not.toContain("disabled");

    // Existing dashboard session is dead too.
    const meRes = await app.inject({ method: "GET", url: "/v5/auth/me", headers: { cookie } });
    expect(meRes.statusCode).toBe(401);

    // Sends rejected with the DISTINCT withhold code.
    const send = await sendOtp(ownedCred, "+8801555000002");
    expect(send.statusCode).toBe(403);
    expect(send.json()).toMatchObject({ ok: false, code: "account_withheld" });

    // Uniform freeze flag: the rest of the owner's app plane is withheld too.
    const balance = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: ownedCred });
    expect(balance.statusCode).toBe(403);
    expect(balance.json()).toMatchObject({ code: "account_withheld" });

    // Credits untouched by the withhold itself.
    expect(otpRemaining(ownedAppId)).toBe(49);

    // Operator-provisioned app (owner NULL) keeps working throughout.
    const other = seedOperatorApp("app_no_owner", "secret-noowner-0123456789abcdef0123456789abcdef");
    const unaffected = await sendOtp(other.cred, "+8801555000003");
    expect(unaffected.statusCode).toBe(201);

    // Directory now reports withheld.
    const afterList = (await op("GET", "/v5/admin/users")).json() as {
      users: { id: string; disabled: boolean }[];
    };
    expect(afterList.users.find((u) => u.id === userId)?.disabled).toBe(true);

    // Enable restores login and sends.
    const enable = await op("POST", `/v5/admin/users/${userId}/enable`);
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ ok: true, disabled: false });

    const loginAgain = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(loginAgain.statusCode).toBe(200);
    const sendAgain = await sendOtp(ownedCred, "+8801555000004");
    expect(sendAgain.statusCode).toBe(201);
  });
});

describe("admin user routes: validation and gate", () => {
  it("404s unknown users, 400s missing ids, and requires the operator secret", async () => {
    const unknown = await op("POST", "/v5/admin/users/no-such-user/disable");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "user_not_found" });

    const noAuth = await app.inject({ method: "POST", url: `/v5/admin/users/${userId}/disable` });
    expect(noAuth.statusCode).toBe(401);

    const listNoAuth = await app.inject({ method: "GET", url: "/v5/admin/users" });
    expect(listNoAuth.statusCode).toBe(401);

    // Idempotent re-disable is fine.
    expect((await op("POST", `/v5/admin/users/${userId}/disable`)).statusCode).toBe(200);
    expect((await op("POST", `/v5/admin/users/${userId}/disable`)).statusCode).toBe(200);
    expect((await op("POST", `/v5/admin/users/${userId}/enable`)).statusCode).toBe(200);
  });
});
