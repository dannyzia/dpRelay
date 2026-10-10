/**
 * STAGE F9 (ISSUE-88) tenancy tests: companies (create/list/rename/disable,
 * the 1:1 app-per-company database invariant), the USER-wallet dual-path
 * (otp pre-check + in-transaction guard, bulk reserve/deduct/refund),
 * trial once-per-user, session wallet purchases approved into the wallet,
 * withheld-company send block, operator-legacy app_credits parity, and the
 * operator apps-list company column.
 *
 * Uses temp DBs + app.inject — no real network, no shared state between
 * tests (each `it` builds its own app unless noted).
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import type { FastifyInstance, InjectOptions } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const OPERATOR = "test-operator-secret-0123456789abcdef";

let app: FastifyInstance;

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-f9-test-"), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: OPERATOR,
      TRIAL_SMS_COUNT: "7",
      TRIAL_SMS_TTL_DAYS: "14",
      BKASH_PERSONAL_NUMBER: "+8801700000000",
      BULK_ENABLED: "true",
      ...env,
    },
  });
}

afterEach(async () => {
  if (app) await app.close();
});

/** Extracts the dp_session cookie value from a Set-Cookie header list. */
function sessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = list.map((c) => /(?:^|;\s*)dp_session=([^;]*)/.exec(c)).find((m) => m !== null);
  if (!match) throw new Error(`no dp_session cookie in Set-Cookie: ${JSON.stringify(list)}`);
  return match[1];
}

/** Registers + returns the session cookie for a fresh user. */
async function registerUser(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/auth/register",
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res.headers["set-cookie"]);
}

function authed(cookie: string, opts: InjectOptions = {}): InjectOptions {
  return { ...opts, headers: { ...(opts.headers ?? {}), cookie: `dp_session=${cookie}` } };
}

interface CompanyApp {
  companyId: string;
  appId: string;
  appSecret: string;
  deviceEnrollmentSecret: string;
  trial: { otpSms: number; bulkSms: number; expiresAt: number } | null;
}

/** Creates a company via the session route and returns its identifiers. */
async function createCompany(a: FastifyInstance, cookie: string, name: string): Promise<CompanyApp> {
  const res = await a.inject(authed(cookie, { method: "POST", url: "/v5/auth/companies", payload: { name } }));
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    company: { id: string };
    app: { appId: string; appSecret: string; deviceEnrollmentSecret: string };
    trial: CompanyApp["trial"];
  };
  return {
    companyId: body.company.id,
    appId: body.app.appId,
    appSecret: body.app.appSecret,
    deviceEnrollmentSecret: body.app.deviceEnrollmentSecret,
    trial: body.trial,
  };
}

function appCred(company: CompanyApp): Record<string, string> {
  return { "x-app-id": company.appId, "x-app-secret": company.appSecret };
}

function userIdOf(a: FastifyInstance, email: string): string {
  const row = a.db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  return row.id;
}

/** Reads the user wallet row (undefined = no wallet yet). */
function walletOf(
  a: FastifyInstance,
  userId: string,
): { otp_sms_remaining: number; bulk_sms_remaining: number; otp_expires_at: number | null } | undefined {
  return a.db
    .prepare("SELECT otp_sms_remaining, bulk_sms_remaining, otp_expires_at FROM user_credits WHERE user_id = ?")
    .get(userId) as
    | { otp_sms_remaining: number; bulk_sms_remaining: number; otp_expires_at: number | null }
    | undefined;
}

/** Overwrites the wallet balance deterministically (no expiry). */
function forceWallet(a: FastifyInstance, userId: string, otp: number, bulk: number): void {
  a.db
    .prepare(
      "INSERT INTO user_credits (user_id, otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, updated_at) " +
        "VALUES (?, ?, ?, NULL, NULL, unixepoch()) " +
        "ON CONFLICT(user_id) DO UPDATE SET otp_sms_remaining = excluded.otp_sms_remaining, " +
        "bulk_sms_remaining = excluded.bulk_sms_remaining, otp_expires_at = NULL, bulk_expires_at = NULL",
    )
    .run(userId, otp, bulk);
}

/** Direct-inserts an operator-provisioned app (no company, no owner) with credits. */
function seedOperatorApp(a: FastifyInstance, appId: string, otp: number): { appRowId: string; cred: Record<string, string> } {
  const secret = `${appId}-secret-0123456789abcdef`;
  const id = crypto.randomUUID();
  a.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(id, appId, sha256Hex(secret), appId);
  a.db
    .prepare("INSERT INTO app_credits (app_id, otp_sms_remaining, updated_at) VALUES (?, ?, unixepoch())")
    .run(id, otp);
  return { appRowId: id, cred: { "x-app-id": appId, "x-app-secret": secret } };
}

async function sendOtp(a: FastifyInstance, cred: Record<string, string>, phone: string) {
  return a.inject({ method: "POST", url: "/v5/otp/send", headers: cred, payload: { phone } });
}

/** Seeds one active OTP package (empty catalog 404s the purchase route). */
function seedPackage(a: FastifyInstance, packageCode: string): void {
  a.db
    .prepare(
      "INSERT INTO packages (id, package_code, name, sms_quota, price_bdt, validity_days, type, is_active, created_at, updated_at) " +
        "VALUES (?, ?, 'Test pack', 100, 20, 30, 'otp', 1, unixepoch(), unixepoch())",
    )
    .run(`pkg-${packageCode}`, packageCode);
}

describe("company lifecycle (session routes)", () => {
  it("creates company+app atomically, shows secrets once, lists with the F7 number placeholder", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "companies@example.com");

    const created = await createCompany(app, cookie, "Haven BD");
    expect(created.trial).toMatchObject({ otpSms: 7, bulkSms: 7 });

    // DB shape: company owned by the user; app bound 1:1 via company_id; the
    // trial landed in the WALLET (no app_credits row for a company app).
    const row = app.db
      .prepare(
        "SELECT c.owner_user_id, c.name AS company_name, a.owner_user_id AS app_owner, " +
          "(SELECT COUNT(*) FROM app_credits c2 WHERE c2.app_id = a.id) AS app_credit_rows " +
          "FROM companies c JOIN apps a ON a.company_id = c.id WHERE a.app_id = ?",
      )
      .get(created.appId) as {
      owner_user_id: string;
      company_name: string;
      app_owner: string;
      app_credit_rows: number;
    };
    const userId = userIdOf(app, "companies@example.com");
    expect(row.owner_user_id).toBe(userId);
    expect(row.app_owner).toBe(userId);
    expect(row.company_name).toBe("Haven BD");
    expect(row.app_credit_rows).toBe(0);
    expect(walletOf(app, userId)?.otp_sms_remaining).toBe(7);

    // List: app summary + gatewayNumber placeholder (null until an F7 device
    // binds); secrets are NEVER re-served.
    const list = await app.inject(authed(cookie, { url: "/v5/auth/companies" }));
    expect(list.statusCode).toBe(200);
    const companies = (list.json() as { companies: Array<Record<string, unknown>> }).companies;
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({
      id: created.companyId,
      name: "Haven BD",
      disabled: false,
      gatewayNumber: null,
      app: { appId: created.appId, revoked: false },
    });
    expect(JSON.stringify(list.json())).not.toContain(created.appSecret);
    expect(JSON.stringify(list.json())).not.toContain(created.deviceEnrollmentSecret);

    // An F7-bound device surfaces its number as the company's gateway number.
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, phone_number, app_id, created_at) " +
          "VALUES ('dev-1', ?, 'gateway', ?, '+8801711112233', (SELECT id FROM apps WHERE app_id = ?), unixepoch())",
      )
      .run(userId, sha256Hex("device-key-hash-material"), created.appId);
    const listWithNumber = await app.inject(authed(cookie, { url: "/v5/auth/companies" }));
    expect((listWithNumber.json() as { companies: Array<Record<string, unknown>> }).companies[0]).toMatchObject({
      gatewayNumber: "+8801711112233",
    });
  });

  it("renames a company, 404s on foreign ids, and disables idempotently", async () => {
    app = makeApp();
    const cookieA = await registerUser(app, "rename-a@example.com");
    const cookieB = await registerUser(app, "rename-b@example.com");
    const companyA = await createCompany(app, cookieA, "Before");
    await createCompany(app, cookieB, "Foreign");

    const renamed = await app.inject(
      authed(cookieA, { method: "PATCH", url: `/v5/auth/companies/${companyA.companyId}`, payload: { name: "After" } }),
    );
    expect(renamed.statusCode).toBe(200);
    const row = app.db.prepare("SELECT name FROM companies WHERE id = ?").get(companyA.companyId) as { name: string };
    expect(row.name).toBe("After");

    // Foreign company: same 404 envelope as unknown id (no enumeration).
    const foreign = await app.inject(
      authed(cookieB, { method: "PATCH", url: `/v5/auth/companies/${companyA.companyId}`, payload: { name: "X" } }),
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "company_not_found" });

    const disabled = await app.inject(
      authed(cookieA, { method: "POST", url: `/v5/auth/companies/${companyA.companyId}/disable` }),
    );
    expect(disabled.statusCode).toBe(200);
    const again = await app.inject(
      authed(cookieA, { method: "POST", url: `/v5/auth/companies/${companyA.companyId}/disable` }),
    );
    expect(again.statusCode).toBe(200);
    const list = await app.inject(authed(cookieA, { url: "/v5/auth/companies" }));
    expect((list.json() as { companies: Array<Record<string, unknown>> }).companies[0]).toMatchObject({ disabled: true });
  });

  it("enforces 1:1 app-per-company as a database invariant", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "one-to-one@example.com");
    const company = await createCompany(app, cookie, "Singleton");
    // A second app row pointing at the same company must throw UNIQUE — the
    // 1:1 is not an application check that a future route could forget.
    expect(() =>
      app.db
        .prepare(
          "INSERT INTO apps (id, app_id, app_secret_hash, name, company_id, created_at) " +
            "VALUES ('x', 'app_dup', 'hash', 'dup', ?, unixepoch())",
        )
        .run(company.companyId),
    ).toThrow(/UNIQUE/i);
  });
});

describe("wallet dual-path (otp)", () => {
  it("two companies of one user draw from ONE wallet balance", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "multi-co@example.com");
    const userId = userIdOf(app, "multi-co@example.com");
    const a1 = await createCompany(app, cookie, "Co A");
    const a2 = await createCompany(app, cookie, "Co B");
    // Both companies share the trial wallet — then pin it deterministically.
    expect(walletOf(app, userId)?.otp_sms_remaining).toBe(7);
    forceWallet(app, userId, 5, 0);

    const first = await sendOtp(app, appCred(a1), "+8801700000001");
    expect(first.statusCode).toBe(201);
    expect(walletOf(app, userId)?.otp_sms_remaining).toBe(4);

    // SAME phone on the second company: different app, SAME wallet.
    const second = await sendOtp(app, appCred(a2), "+8801700000001");
    expect(second.statusCode).toBe(201);
    expect(walletOf(app, userId)?.otp_sms_remaining).toBe(3);

    // Never touched any app bucket: company apps have no app_credits row.
    const strayRows = app.db
      .prepare(
        "SELECT COUNT(*) AS n FROM app_credits c JOIN apps a ON a.id = c.app_id " +
          "JOIN companies co ON co.id = a.company_id WHERE co.owner_user_id = ?",
      )
      .get(userId) as { n: number };
    expect(strayRows.n).toBe(0);
  });

  it("an operator-legacy app still deducts app_credits exactly as today", async () => {
    app = makeApp();
    const legacy = seedOperatorApp(app, "legacy-ops-app", 50);
    const res = await sendOtp(app, legacy.cred, "+8801700000002");
    expect(res.statusCode).toBe(201);
    const credits = app.db
      .prepare("SELECT otp_sms_remaining FROM app_credits WHERE app_id = ?")
      .get(legacy.appRowId) as { otp_sms_remaining: number };
    expect(credits.otp_sms_remaining).toBe(49);
    const wallets = app.db.prepare("SELECT COUNT(*) AS n FROM user_credits").get() as { n: number };
    expect(wallets.n).toBe(0);
  });

  it("402s an expired wallet bucket with NO deduction (same envelope as app plane)", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "expired-wallet@example.com");
    const userId = userIdOf(app, "expired-wallet@example.com");
    const company = await createCompany(app, cookie, "Expiry Co");
    forceWallet(app, userId, 3, 0);
    app.db
      .prepare("UPDATE user_credits SET otp_expires_at = unixepoch() - 1 WHERE user_id = ?")
      .run(userId);

    const res = await sendOtp(app, appCred(company), "+8801700000003");
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: "insufficient_credits" });
    expect(walletOf(app, userId)?.otp_sms_remaining).toBe(3);
  });

  it("a withheld company blocks its app's sends at the choke point (403 company_disabled)", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "withheld-co@example.com");
    const company = await createCompany(app, cookie, "Withheld Co");
    forceWallet(app, userIdOf(app, "withheld-co@example.com"), 10, 10);

    const disabled = await app.inject(
      authed(cookie, { method: "POST", url: `/v5/auth/companies/${company.companyId}/disable` }),
    );
    expect(disabled.statusCode).toBe(200);

    const blocked = await sendOtp(app, appCred(company), "+8801700000004");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "company_disabled" });
    // Wallet untouched by the blocked send.
    expect(walletOf(app, userIdOf(app, "withheld-co@example.com"))?.otp_sms_remaining).toBe(10);
  });
});

describe("wallet dual-path (bulk)", () => {
  it("reserves from the wallet and refunds to the wallet on cancel", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "bulk-wallet@example.com");
    const userId = userIdOf(app, "bulk-wallet@example.com");
    const company = await createCompany(app, cookie, "Bulk Co");
    forceWallet(app, userId, 0, 10);

    const phones = ["+8801700000005", "+8801700000006"];
    const preview = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns/preview",
      headers: appCred(company),
      payload: { phones },
    });
    expect(preview.statusCode).toBe(200);
    const checksum = (preview.json() as { checksum: string }).checksum;

    const create = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: appCred(company),
      payload: {
        campaignName: "Wallet campaign",
        message: "Hello from dP Relay",
        phones,
        checksum,
      },
    });
    expect(create.statusCode).toBe(201);
    const campaignId = (create.json() as { campaignId: string }).campaignId;
    expect(walletOf(app, userId)?.bulk_sms_remaining).toBe(8);

    const cancel = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${campaignId}/cancel`,
      headers: appCred(company),
    });
    expect(cancel.statusCode).toBe(200);
    // Refund lands in the SAME wallet the deduct left.
    expect(walletOf(app, userId)?.bulk_sms_remaining).toBe(10);
    const strayRows = app.db.prepare("SELECT COUNT(*) AS n FROM app_credits").get() as { n: number };
    expect(strayRows.n).toBe(0);
  });
});

describe("wallet purchases (session route + operator approval)", () => {
  it("attributes a session purchase to the USER and awards the wallet on approve", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "wallet-buy@example.com");
    const userId = userIdOf(app, "wallet-buy@example.com");
    await createCompany(app, cookie, "Buy Co");
    forceWallet(app, userId, 0, 0);
    seedPackage(app, "otp-100");

    const request = await app.inject(
      authed(cookie, {
        method: "POST",
        url: "/v5/billing/credits/request",
        payload: { packageCode: "otp-100" },
      }),
    );
    // Package catalog must contain the code — seed one if the default catalog
    // shape differs; the route 404s on unknown codes.
    expect(request.statusCode).toBe(201);
    const { transactionId } = request.json() as { transactionId: string };
    const trx = app.db
      .prepare("SELECT app_id, user_id, status FROM credit_transactions WHERE id = ?")
      .get(transactionId) as { app_id: string | null; user_id: string | null; status: string };
    expect(trx.user_id).toBe(userId);
    expect(trx.app_id).toBeNull();
    expect(trx.status).toBe("pending");

    // Operator queue surfaces the user attribution.
    const queue = await app.inject({
      method: "GET",
      url: "/v5/admin/billing/queue",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(queue.statusCode).toBe(200);
    const pending = (queue.json() as { pending: Array<Record<string, unknown>> }).pending;
    expect(pending.find((t) => t.transactionId === transactionId)).toMatchObject({ userId, appId: null, currency: "BDT" });

    const approve = await app.inject({
      method: "POST",
      url: "/v5/admin/billing/approve",
      headers: { authorization: `Bearer ${OPERATOR}` },
      payload: { transactionId, approve: true },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ status: "approved" });

    const wallet = walletOf(app, userId);
    expect(wallet).toBeDefined();
    expect((wallet?.otp_sms_remaining ?? 0) + (wallet?.bulk_sms_remaining ?? 0)).toBeGreaterThan(0);

    // The wallet view lists the approved purchase.
    const history = await app.inject(authed(cookie, { url: "/v5/auth/wallet/transactions" }));
    expect(history.statusCode).toBe(200);
    const rows = (history.json() as { transactions: Array<Record<string, unknown>> }).transactions;
    expect(rows.find((t) => t.transactionId === transactionId)).toMatchObject({ status: "approved", currency: "BDT" });
  });

  it("an app-credential purchase for a COMPANY app is also wallet-attributed; submit-trx enforces ownership", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "app-buy@example.com");
    const userId = userIdOf(app, "app-buy@example.com");
    const company = await createCompany(app, cookie, "API Buy Co");
    seedPackage(app, "otp-100");

    // App-auth request for a company-backed app: wallet attribution (its
    // spends draw from the wallet — an app-attributed award would be dead
    // money).
    const request = await app.inject({
      method: "POST",
      url: "/v5/billing/credits/request",
      headers: appCred(company),
      payload: { packageCode: "otp-100" },
    });
    expect(request.statusCode).toBe(201);
    const { transactionId } = request.json() as { transactionId: string };
    const trx = app.db
      .prepare("SELECT app_id, user_id FROM credit_transactions WHERE id = ?")
      .get(transactionId) as { app_id: string | null; user_id: string | null };
    expect(trx.user_id).toBe(userId);
    expect(trx.app_id).toBeNull();

    // A FOREIGN session cannot attach a TrxID to someone else's transaction
    // (404 shares the unknown-id envelope — no enumeration).
    const foreignCookie = await registerUser(app, "app-buy-foreign@example.com");
    const foreign = await app.inject(
      authed(foreignCookie, {
        method: "POST",
        url: "/v5/billing/credits/submit-trx",
        payload: { transactionId, trxId: "TRX-F9-0001" },
      }),
    );
    expect(foreign.statusCode).toBe(404);

    // The owner's session can.
    const own = await app.inject(
      authed(cookie, {
        method: "POST",
        url: "/v5/billing/credits/submit-trx",
        payload: { transactionId, trxId: "TRX-F9-0001" },
      }),
    );
    expect(own.statusCode).toBe(200);
  });
});

describe("operator plane", () => {
  it("the apps list gains a company column (null for operator-provisioned apps)", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "op-column@example.com");
    const company = await createCompany(app, cookie, "Column Co");
    seedOperatorApp(app, "legacy-column-app", 0);

    const res = await app.inject({
      method: "GET",
      url: "/v5/admin/apps",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(res.statusCode).toBe(200);
    const apps = (res.json() as { apps: Array<Record<string, unknown>> }).apps;
    const owned = apps.find((a) => a.appId === company.appId);
    expect(owned?.company).toMatchObject({ id: company.companyId, name: "Column Co" });
    const legacy = apps.find((a) => a.appId === "legacy-column-app");
    expect(legacy?.company).toBeNull();
  });
});
