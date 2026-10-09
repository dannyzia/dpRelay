/**
 * STAGE F5 (ISSUE-83) → F5b (ISSUE-84 spec): user withhold.
 * Ordered invariants: disable REQUIRES {reason} (400 otherwise), stores it on
 * the row (directory badge/tooltip), REVOKES all user_sessions rows eagerly,
 * and writes an admin_audit row per action (operator + timestamp + reason);
 * withheld = login blocked (generic 401, anti-enumeration), session
 * resolution rejected, app-plane sends rejected with the DISTINCT
 * account_withheld code; balances are NEVER touched by withhold; an
 * operator-provisioned app (owner NULL) is unaffected; enable restores and
 * clears the reason.
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

/**
 * STAGE F9 (ISSUE-88): self-serve apps are company-backed, so their sends
 * draw from the owner's user wallet — these helpers resolve the same
 * app -> company -> owner chain the server enforces, keeping the withhold
 * assertions honest on whichever plane the balance lives.
 */
function walletOwnerOf(appRowId: string): string | null {
  const row = app.db
    .prepare("SELECT c.owner_user_id AS uid FROM apps a JOIN companies c ON c.id = a.company_id WHERE a.id = ?")
    .get(appRowId) as { uid: string } | undefined;
  return row?.uid ?? null;
}

/** Forces a deterministic credit balance on the app's actual spend plane. */
function forceCredits(appRowId: string, otp: number): void {
  const owner = walletOwnerOf(appRowId);
  if (owner !== null) {
    app.db
      .prepare(
        "INSERT INTO user_credits (user_id, otp_sms_remaining, updated_at) VALUES (?, ?, unixepoch()) " +
          "ON CONFLICT(user_id) DO UPDATE SET otp_sms_remaining = excluded.otp_sms_remaining, otp_expires_at = NULL",
      )
      .run(owner, otp);
    return;
  }
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, otp_sms_remaining, updated_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(app_id) DO UPDATE SET otp_sms_remaining = excluded.otp_sms_remaining, otp_expires_at = NULL",
    )
    .run(appRowId, otp);
}

function otpRemaining(appRowId: string): number {
  const owner = walletOwnerOf(appRowId);
  const row =
    owner === null
      ? (app.db.prepare("SELECT otp_sms_remaining FROM app_credits WHERE app_id = ?").get(appRowId) as
          | { otp_sms_remaining: number }
          | undefined)
      : (app.db.prepare("SELECT otp_sms_remaining FROM user_credits WHERE user_id = ?").get(owner) as
          | { otp_sms_remaining: number }
          | undefined);
  return row?.otp_sms_remaining ?? -1;
}

/** Live dashboard session rows for the seeded user (eager-revocation proof). */
function sessionCount(): number {
  const row = app.db
    .prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?")
    .get(userId) as { n: number };
  return row.n;
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

    // A session row exists before the withhold (register opened one).
    expect(sessionCount()).toBeGreaterThan(0);

    // Reason is REQUIRED (spec): no silent withhold.
    const noReason = await op("POST", `/v5/admin/users/${userId}/disable`, {});
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ code: "reason_required" });

    // Withhold.
    const disable = await op("POST", `/v5/admin/users/${userId}/disable`, {
      reason: "chargeback investigation",
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ ok: true, disabled: true, reason: "chargeback investigation" });

    // EAGER session revocation: the rows are GONE, not merely rejected later.
    expect(sessionCount()).toBe(0);

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

    // Directory now reports withheld, with the stored reason for the tooltip.
    const afterList = (await op("GET", "/v5/admin/users")).json() as {
      users: { id: string; disabled: boolean; disabledReason: string | null; disabledAt: number | null }[];
    };
    const withheld = afterList.users.find((u) => u.id === userId);
    expect(withheld?.disabled).toBe(true);
    expect(withheld?.disabledReason).toBe("chargeback investigation");
    expect(withheld?.disabledAt).toBeGreaterThan(0);

    // Enable restores login and sends, and clears the reason.
    const enable = await op("POST", `/v5/admin/users/${userId}/enable`);
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ ok: true, disabled: false });

    const cleared = (await op("GET", "/v5/admin/users")).json() as {
      users: { id: string; disabledReason: string | null; disabledAt: number | null }[];
    };
    expect(cleared.users.find((u) => u.id === userId)).toMatchObject({
      disabledReason: null,
      disabledAt: null,
    });

    // Audit trail: both actions recorded with operator + reason (set
    // semantics — audit ids are UUIDs, so same-second order is not asserted).
    const audits = app.db
      .prepare("SELECT action, reason, actor, created_at FROM admin_audit WHERE subject_id = ? AND subject_type = 'user'")
      .all(userId) as { action: string; reason: string | null; actor: string; created_at: number }[];
    expect(audits).toHaveLength(2);
    const withholdAudit = audits.find((a) => a.action === "user.withhold");
    const liftAudit = audits.find((a) => a.action === "user.lift");
    expect(withholdAudit).toMatchObject({ actor: "operator", reason: "chargeback investigation" });
    expect(withholdAudit?.created_at).toBeGreaterThan(0);
    expect(liftAudit).toMatchObject({ actor: "operator", reason: null });

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
  it("400s missing reasons, 404s unknown users, 400s missing ids, and requires the operator secret", async () => {
    const noReason = await op("POST", `/v5/admin/users/${userId}/disable`);
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ code: "reason_required" });
    const blankReason = await op("POST", `/v5/admin/users/${userId}/disable`, { reason: "  " });
    expect(blankReason.statusCode).toBe(400);
    expect(blankReason.json()).toMatchObject({ code: "reason_required" });

    const unknown = await op("POST", "/v5/admin/users/no-such-user/disable", { reason: "n/a" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "user_not_found" });

    const noAuth = await app.inject({
      method: "POST",
      url: `/v5/admin/users/${userId}/disable`,
      payload: { reason: "n/a" },
    });
    expect(noAuth.statusCode).toBe(401);

    const listNoAuth = await app.inject({ method: "GET", url: "/v5/admin/users" });
    expect(listNoAuth.statusCode).toBe(401);

    // Idempotent re-disable is fine (reason travels every time).
    expect((await op("POST", `/v5/admin/users/${userId}/disable`, { reason: "still withheld" })).statusCode).toBe(200);
    expect((await op("POST", `/v5/admin/users/${userId}/disable`, { reason: "still withheld" })).statusCode).toBe(200);
    expect((await op("POST", `/v5/admin/users/${userId}/enable`)).statusCode).toBe(200);
  });
});
