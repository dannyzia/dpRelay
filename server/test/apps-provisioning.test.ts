/**
 * App provisioning route tests (ISSUE-11): operator-gated POST /v5/apps/register
 * — mint + return-once semantics, hash-only storage of the caller-supplied
 * appSecret, webhook_secret/hash sync, duplicate rejection, validation, the
 * brute-force limiter, and end-to-end usability of provisioned credentials
 * against requireApp.
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "apps-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_PROVISION_SECRET = "provision-op-secret-0123456789abcdef0123456789";
const TEST_APP_ID = "acme_app";
const TEST_APP_SECRET = "acme-app-secret-0123456789abcdef0123456789abc";
const PHONE = "+8801712345678";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-apps-test-"), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      APP_PROVISIONING_SECRET: TEST_PROVISION_SECRET,
      ...extra,
    },
  });
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

interface ProvisionBody {
  appId?: string;
  appSecret?: string;
  name?: string;
  webhookUrl?: string;
}

async function provision(
  a: FastifyInstance,
  body: ProvisionBody,
  secret: string = TEST_PROVISION_SECRET,
): Promise<{ statusCode: number; body: Record<string, unknown>; retryAfter?: string }> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/apps/register",
    headers: { authorization: `Bearer ${secret}` },
    payload: body,
  });
  return {
    statusCode: res.statusCode,
    body: res.json() as Record<string, unknown>,
    retryAfter: res.headers["retry-after"] as string | undefined,
  };
}

describe("POST /v5/apps/register", () => {
  it("403s with provisioning_disabled when APP_PROVISIONING_SECRET is unset", async () => {
    app = makeApp({ APP_PROVISIONING_SECRET: "" });
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("provisioning_disabled");
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n).toBe(0);
  });

  it("401s on a wrong operator secret and on a missing header", async () => {
    app = makeApp();
    const wrong = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET }, "totally-wrong-secret");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body.code).toBe("invalid_provisioning_secret");

    const noHeader = await app.inject({
      method: "POST",
      url: "/v5/apps/register",
      payload: { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET },
    });
    expect(noHeader.statusCode).toBe(401);
  });

  it("mints an app: 201, secret returned once, hash-only appSecret, webhook secret/hash in sync", async () => {
    app = makeApp();
    const res = await provision(app, {
      appId: TEST_APP_ID,
      appSecret: TEST_APP_SECRET,
      name: "Acme",
      webhookUrl: "https://example.com/hooks/otp",
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.appId).toBe(TEST_APP_ID);
    expect(res.body.name).toBe("Acme");
    expect(res.body.webhookUrl).toBe("https://example.com/hooks/otp");
    const webhookSecret = res.body.webhookSecret as string;
    expect(typeof webhookSecret).toBe("string");
    expect(webhookSecret.length).toBeGreaterThanOrEqual(64);

    const row = app.db
      .prepare(
        "SELECT app_id, app_secret_hash, webhook_url, webhook_secret, webhook_secret_hash, name " +
          "FROM apps WHERE app_id = ?",
      )
      .get(TEST_APP_ID) as {
      app_id: string;
      app_secret_hash: string;
      webhook_url: string | null;
      webhook_secret: string | null;
      webhook_secret_hash: string | null;
      name: string;
    };
    // Caller-supplied appSecret: stored as digest only, digest matches the raw.
    expect(row.app_secret_hash).toBe(sha256Hex(TEST_APP_SECRET));
    expect(row.webhook_url).toBe("https://example.com/hooks/otp");
    // Server-minted webhook secret: plaintext persisted (server signs) + hash in sync.
    expect(row.webhook_secret).toBe(webhookSecret);
    expect(row.webhook_secret_hash).toBe(sha256Hex(webhookSecret));
  });

  it("mints a distinct webhook secret per app", async () => {
    app = makeApp();
    const first = await provision(app, { appId: "app_one", appSecret: TEST_APP_SECRET });
    const second = await provision(app, { appId: "app_two", appSecret: TEST_APP_SECRET });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.body.webhookSecret).not.toBe(second.body.webhookSecret);
  });

  it("409s on a duplicate appId and leaves the existing row untouched", async () => {
    app = makeApp();
    const first = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(first.statusCode).toBe(201);
    const originalWebhookSecret = first.body.webhookSecret as string;

    const dup = await provision(app, { appId: TEST_APP_ID, appSecret: "other-secret-0123456789abcdef0123456789" });
    expect(dup.statusCode).toBe(409);
    expect(dup.body.code).toBe("app_id_exists");

    const rows = app.db
      .prepare("SELECT app_id, webhook_secret FROM apps WHERE app_id = ?")
      .all(TEST_APP_ID) as { app_id: string; webhook_secret: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].webhook_secret).toBe(originalWebhookSecret);
  });

  it("400s on invalid appId, short appSecret, and non-https webhookUrl", async () => {
    app = makeApp();
    const badIds = [
      { appId: "no", appSecret: TEST_APP_SECRET }, // too short
      { appId: "bad space", appSecret: TEST_APP_SECRET }, // illegal charset
      { appSecret: TEST_APP_SECRET }, // missing
    ];
    for (const body of badIds) {
      const res = await provision(app, body);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("invalid_app_id");
    }

    const shortSecret = await provision(app, { appId: TEST_APP_ID, appSecret: "short" });
    expect(shortSecret.statusCode).toBe(400);
    expect(shortSecret.body.code).toBe("invalid_app_secret");

    const httpUrl = await provision(app, {
      appId: TEST_APP_ID,
      appSecret: TEST_APP_SECRET,
      webhookUrl: "http://example.com/hooks",
    });
    expect(httpUrl.statusCode).toBe(400);
    expect(httpUrl.body.code).toBe("invalid_webhook_url");

    const garbageUrl = await provision(app, {
      appId: TEST_APP_ID,
      appSecret: TEST_APP_SECRET,
      webhookUrl: "not-a-url",
    });
    expect(garbageUrl.statusCode).toBe(400);
    expect(garbageUrl.body.code).toBe("invalid_webhook_url");

    expect((app.db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n).toBe(0);
  });

  it("429s past the per-IP provisioning limit (all attempts count)", async () => {
    app = makeApp({ APP_PROVISIONING_RATE_MAX_PER_HOUR: "2" });
    const first = await provision(app, { appId: "nope", appSecret: "x" }); // 400, counts
    expect(first.statusCode).toBe(400);
    const second = await provision(app, { appId: "nope", appSecret: "x" }); // 400, counts
    expect(second.statusCode).toBe(400);
    const third = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(third.statusCode).toBe(429);
    expect(third.body.code).toBe("rate_limited");
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n).toBe(0);
  });

  it("provisioned credentials authenticate /v5/otp/send via requireApp end-to-end", async () => {
    app = makeApp();
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(201);
    // Stage E: sends spend 1 OTP credit (402 at zero) — registration now
    // seeds the balance itself via the ISSUE-77 trial, so the old manual
    // INSERT would collide with the trial row's primary key.
    const seeded = app.db
      .prepare(
        "SELECT otp_sms_remaining FROM app_credits ac JOIN apps a ON a.id = ac.app_id " +
          "WHERE a.app_id = ?",
      )
      .get(TEST_APP_ID) as { otp_sms_remaining: number };
    expect(seeded.otp_sms_remaining).toBe(20);

    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": TEST_APP_ID, "x-app-secret": TEST_APP_SECRET },
      payload: { phone: PHONE },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().ok).toBe(true);

    // A wrong secret for the minted app must still 401 — hash-only storage verifies.
    const badSecret = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": TEST_APP_ID, "x-app-secret": "wrong-secret" },
      payload: { phone: PHONE },
    });
    expect(badSecret.statusCode).toBe(401);
  });
});

describe("one-time trial credits (ISSUE-77)", () => {
  const CREDITS_BY_APP =
    "SELECT otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, last_transaction_id " +
    "FROM app_credits ac JOIN apps a ON a.id = ac.app_id WHERE a.app_id = ?";

  it("grants the default 20 OTP + 20 bulk atomically with registration, expiring after 30 days", async () => {
    app = makeApp();
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(201);
    const trial = res.body.trial as { otpSms: number; bulkSms: number; expiresAt: number };
    expect(trial.otpSms).toBe(20);
    expect(trial.bulkSms).toBe(20);

    const row = app.db.prepare(CREDITS_BY_APP).get(TEST_APP_ID) as {
      otp_sms_remaining: number;
      bulk_sms_remaining: number;
      otp_expires_at: number;
      bulk_expires_at: number;
      last_transaction_id: string | null;
    };
    expect(row.otp_sms_remaining).toBe(20);
    expect(row.bulk_sms_remaining).toBe(20);
    const expectedExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
    expect(Math.abs(row.otp_expires_at - expectedExpiry)).toBeLessThan(60);
    expect(row.bulk_expires_at).toBe(row.otp_expires_at);
    expect(Math.abs(trial.expiresAt - row.otp_expires_at)).toBeLessThan(5);
    // The trial is a grant, not a purchase: no ledger row, no transaction id.
    expect(row.last_transaction_id).toBeNull();
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM credit_transactions").get() as { n: number }).n).toBe(0);
  });

  it("is one-time at the DB level: duplicate register 409s, balance never re-fires", async () => {
    app = makeApp();
    const first = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(first.statusCode).toBe(201);

    const dup = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(dup.statusCode).toBe(409);
    expect(dup.body.code).toBe("app_id_exists");
    expect(dup.body.trial).toBeUndefined();

    const balance = () =>
      app.db
        .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM app_credits ac JOIN apps a ON a.id = ac.app_id WHERE a.app_id = ?")
        .get(TEST_APP_ID) as { otp_sms_remaining: number; bulk_sms_remaining: number } | undefined;
    expect(balance()).toEqual({ otp_sms_remaining: 20, bulk_sms_remaining: 20 });
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM app_credits").get() as { n: number }).n).toBe(1);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n).toBe(1);

    // The one-time property is the schema's, not application code's: a second
    // grant row for the same app is refused by the primary key itself.
    expect(() =>
      app.db
        .prepare(
          "INSERT INTO app_credits (app_id, otp_sms_remaining, bulk_sms_remaining, updated_at) " +
            "SELECT id, 20, 20, unixepoch() FROM apps WHERE app_id = ?",
        )
        .run(TEST_APP_ID),
    ).toThrow(/UNIQUE constraint failed: app_credits.app_id/);
    expect(balance()).toEqual({ otp_sms_remaining: 20, bulk_sms_remaining: 20 });
  });

  it("tunes the grant with TRIAL_SMS_COUNT", async () => {
    app = makeApp({ TRIAL_SMS_COUNT: "5" });
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(201);
    expect(res.body.trial).toMatchObject({ otpSms: 5, bulkSms: 5 });
    const row = app.db
      .prepare("SELECT otp_sms_remaining, bulk_sms_remaining FROM app_credits ac JOIN apps a ON a.id = ac.app_id WHERE a.app_id = ?")
      .get(TEST_APP_ID) as { otp_sms_remaining: number; bulk_sms_remaining: number };
    expect(row).toEqual({ otp_sms_remaining: 5, bulk_sms_remaining: 5 });
  });

  it("TRIAL_SMS_COUNT=0 disables the grant: no row, trial null, send fails closed 402", async () => {
    app = makeApp({ TRIAL_SMS_COUNT: "0" });
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(201);
    expect(res.body.trial).toBeNull();
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM app_credits").get() as { n: number }).n).toBe(0);

    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": TEST_APP_ID, "x-app-secret": TEST_APP_SECRET },
      payload: { phone: PHONE },
    });
    expect(send.statusCode).toBe(402);
    expect((send.json() as { code: string }).code).toBe("insufficient_credits");
  });

  it("tunes the expiry with TRIAL_SMS_TTL_DAYS (both buckets)", async () => {
    app = makeApp({ TRIAL_SMS_TTL_DAYS: "7" });
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(201);
    const row = app.db
      .prepare("SELECT otp_expires_at, bulk_expires_at FROM app_credits ac JOIN apps a ON a.id = ac.app_id WHERE a.app_id = ?")
      .get(TEST_APP_ID) as { otp_expires_at: number; bulk_expires_at: number };
    const expectedExpiry = Math.floor(Date.now() / 1000) + 7 * 86400;
    expect(Math.abs(row.otp_expires_at - expectedExpiry)).toBeLessThan(60);
    expect(row.bulk_expires_at).toBe(row.otp_expires_at);
  });

  it("trial credits are spendable and fail closed at zero", async () => {
    app = makeApp({ TRIAL_SMS_COUNT: "3" });
    const res = await provision(app, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET });
    expect(res.statusCode).toBe(201);

    // Distinct numbers so the per-phone rate limit (3/hour) and resend
    // cooldown cannot mask the credit path being tested.
    const send = (phone: string) =>
      app.inject({
        method: "POST",
        url: "/v5/otp/send",
        headers: { "x-app-id": TEST_APP_ID, "x-app-secret": TEST_APP_SECRET },
        payload: { phone },
      });
    for (const phone of ["+8801711111111", "+8801711111112", "+8801711111113"]) {
      expect((await send(phone)).statusCode).toBe(201);
    }
    const spent = app.db
      .prepare("SELECT otp_sms_remaining FROM app_credits ac JOIN apps a ON a.id = ac.app_id WHERE a.app_id = ?")
      .get(TEST_APP_ID) as { otp_sms_remaining: number };
    expect(spent.otp_sms_remaining).toBe(0);

    const fourth = await send("+8801711111114");
    expect(fourth.statusCode).toBe(402);
    expect((fourth.json() as { code: string }).code).toBe("insufficient_credits");
  });

  it("fails fast at boot on malformed trial env (no silent fallback)", async () => {
    app = makeApp(); // a live instance so afterEach closes something real
    expect(() => makeApp({ TRIAL_SMS_COUNT: "abc" })).toThrow(/TRIAL_SMS_COUNT/);
    expect(() => makeApp({ TRIAL_SMS_COUNT: "-5" })).toThrow(/TRIAL_SMS_COUNT/);
    expect(() => makeApp({ TRIAL_SMS_TTL_DAYS: "0" })).toThrow(/TRIAL_SMS_TTL_DAYS/);
  });
});
