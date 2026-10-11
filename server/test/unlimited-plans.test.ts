/**
 * ISSUE-96 — Unlimited BYOD phone plans. Centerpiece: the credit bypass is
 * ONLY ever granted to an app that (a) holds an active subscription and
 * (b) has at least one live bound device — a subscribed app whose sends would
 * ride the dedicated BD operator pool is charged exactly as before, and an
 * expired subscription fails closed. Also covers: device slot limits at
 * enrollment (atomic), slot freed by delete, the 24h churn cooldown, the
 * pending → TrxID → operator-approval purchase lifecycle with renewal
 * extension, and bulk free-pass snapshot semantics (no reserve, no refund,
 * no retry deduction).
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "unlimited-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "unlimited-operator-secret-0123456789abcdef0123";
const TEST_ENROLLMENT_SECRET = "enroll-only-secret-0123456789abcdef0123456789ab";
const BKASH = "+8801711000000";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-unlimited-test-"), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: TEST_OPERATOR_SECRET,
      DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET,
      BKASH_PERSONAL_NUMBER: BKASH,
      BULK_ENABLED: "true",
      ...extra,
    },
  });
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

const APP_SECRET = "secret-a-0123456789abcdef0123456789abcdef";
const APP_ENROLL_SECRET = "app-enroll-secret-0123456789abcdef012345678";
const CRED_A = { "x-app-id": "app_a", "x-app-secret": APP_SECRET };

/** Inserts an app row with a per-app device enrollment secret (F7 binding). */
function seedApp(appId: string): string {
  const id = randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, device_enrollment_secret_hash, created_at) " +
        "VALUES (?, ?, ?, ?, ?, unixepoch())",
    )
    .run(id, appId, sha256Hex(APP_SECRET), appId, sha256Hex(APP_ENROLL_SECRET));
  return id;
}

/**
 * Seeds an app_subscriptions row directly (tests isolate the enforcement from
 * the purchase route; the lifecycle test covers the route itself).
 */
function seedSubscription(
  appRowId: string,
  opts: { planCode?: string; maxDevices?: number; status?: string; expiresAt?: number } = {},
): string {
  const id = randomUUID();
  const expiresAt = opts.expiresAt ?? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  app.db
    .prepare(
      "INSERT INTO app_subscriptions (id, app_id, plan_code, max_devices, price_usd, status, starts_at, expires_at, requested_at) " +
        "VALUES (?, ?, ?, ?, 16, ?, unixepoch(), ?, unixepoch())",
    )
    .run(id, appRowId, opts.planCode ?? "unlimited_1", opts.maxDevices ?? 1, opts.status ?? "active", expiresAt);
  return id;
}

/** Enrolls a device through the public route with the app-scoped secret. */
async function enrollAppDevice(label = "byod phone") {
  return app.inject({
    method: "POST",
    url: "/v5/device/enroll",
    headers: { authorization: `Bearer ${APP_ENROLL_SECRET}` },
    payload: { label },
  });
}

async function opPost(url: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${TEST_OPERATOR_SECRET}` },
    payload,
  });
}

describe("device slot limits + churn cooldown", () => {
  it("rejects enrollment past the plan's slot limit with 409 device_limit_reached", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });

    const first = await enrollAppDevice("phone-1");
    expect(first.statusCode).toBe(201);

    const second = await enrollAppDevice("phone-2");
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("device_limit_reached");
  });

  it("deleting a device frees its slot for a new enrollment", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });

    const first = await enrollAppDevice("phone-1");
    expect(first.statusCode).toBe(201);
    const { deviceId } = first.json() as { deviceId: string };

    // The list route reports the bound device as active (slots view input).
    const list = await app.inject({ method: "GET", url: "/v5/apps/devices", headers: CRED_A });
    expect(list.statusCode).toBe(200);
    const listed = list.json() as { devices: { deviceId: string; active: boolean; label: string }[] };
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ deviceId, active: true, label: "phone-1" });

    // Revoke frees the slot (soft delete; the key dies at requireDevice).
    const removed = await app.inject({
      method: "DELETE",
      url: `/v5/apps/devices/${deviceId}`,
      headers: CRED_A,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().devicesActive).toBe(0);

    // After deletion the row is history: inactive, but still listed.
    const listAfter = await app.inject({ method: "GET", url: "/v5/apps/devices", headers: CRED_A });
    const listedAfter = (listAfter.json() as { devices: { deviceId: string; active: boolean }[] }).devices;
    expect(listedAfter).toHaveLength(1);
    expect(listedAfter[0]).toMatchObject({ deviceId, active: false });

    const second = await enrollAppDevice("phone-2");
    expect(second.statusCode).toBe(201);

    // Idempotent second delete of the same id → 200 (already revoked; the
    // slot was already freed and the response reports the current count).
    const again = await app.inject({
      method: "DELETE",
      url: `/v5/apps/devices/${deviceId}`,
      headers: CRED_A,
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { devicesActive: number }).devicesActive).toBe(1); // phone-2 occupies it
  });

  it("429s when a 1-phone plan cycles devices beyond the 24h churn allowance", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });

    // Allowance = max_devices + 1 enrollments per rolling 24h. Each cycle
    // frees the slot first (delete → enroll), so the SLOT limit never fires;
    // the third enrollment in the window trips the churn cap.
    const cycle = async (label: string): Promise<{ statusCode: number; json: () => Record<string, unknown> }> => {
      const res = await enrollAppDevice(label);
      if (res.statusCode === 201) {
        const { deviceId } = res.json() as { deviceId: string };
        await app.inject({
          method: "DELETE",
          url: `/v5/apps/devices/${deviceId}`,
          headers: CRED_A,
        });
      }
      return res;
    };
    expect((await cycle("cycle-1")).statusCode).toBe(201);
    expect((await cycle("cycle-2")).statusCode).toBe(201);

    const third = await enrollAppDevice("cycle-3");
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe("device_churn_limited");
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("does not limit enrollment for apps without a subscription (legacy behavior)", async () => {
    app = makeApp();
    seedApp("app_a");
    for (let i = 0; i < 3; i++) {
      const res = await enrollAppDevice(`legacy-${i}`);
      expect(res.statusCode).toBe(201);
    }
  });
});

describe("plan purchase → TrxID → operator approval", () => {
  it("runs the full lifecycle; approval extends from the previous expiry on renewal", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");

    // No plan yet: purchase creates a pending row and returns the destination.
    const buy = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: CRED_A,
      payload: { planCode: "unlimited_1" },
    });
    expect(buy.statusCode).toBe(201);
    const purchase = buy.json() as { subscriptionId: string; priceUsd: number; bkashNumber: string };
    expect(purchase.priceUsd).toBe(16);
    expect(purchase.bkashNumber).toBe(BKASH);

    // A second purchase while one is pending → 409.
    const dup = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: CRED_A,
      payload: { planCode: "unlimited_5" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("plan_purchase_pending");

    // Status shows the pending purchase, subscription still null.
    const status1 = await app.inject({ method: "GET", url: "/v5/billing/subscription", headers: CRED_A });
    expect(status1.json().subscription).toBeNull();
    expect(status1.json().pending.subscriptionId).toBe(purchase.subscriptionId);

    // Attach TrxID (10 uppercase alnum), then operator approves.
    const trx = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/submit-trx",
      headers: CRED_A,
      payload: { subscriptionId: purchase.subscriptionId, trxId: "9F2K7QX1MA" },
    });
    expect(trx.statusCode).toBe(200);

    const approve = await opPost("/v5/admin/billing/plans/approve", {
      subscriptionId: purchase.subscriptionId,
      approve: true,
    });
    expect(approve.statusCode).toBe(200);
    const firstExpiry = (approve.json() as { expiresAt: number }).expiresAt;
    expect(firstExpiry).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 24 * 60 * 60);

    const status2 = await app.inject({ method: "GET", url: "/v5/billing/subscription", headers: CRED_A });
    const sub = status2.json() as {
      subscription: { planCode: string; maxDevices: number; active: boolean; expiresAt: number };
      devices: { active: number; limit: number };
    };
    expect(sub.subscription.planCode).toBe("unlimited_1");
    expect(sub.subscription.maxDevices).toBe(1);
    expect(sub.subscription.active).toBe(true);
    expect(sub.devices).toEqual({ active: 0, limit: 1 });

    // Double-approve is a 409, never a double award.
    const again = await opPost("/v5/admin/billing/plans/approve", {
      subscriptionId: purchase.subscriptionId,
      approve: true,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("already_resolved");

    // Renewal (upgrade to 5 phones) extends from the STILL-FUTURE previous
    // expiry instead of restarting the 30-day clock.
    const buy2 = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: CRED_A,
      payload: { planCode: "unlimited_5" },
    });
    expect(buy2.statusCode).toBe(201);
    const purchase2 = buy2.json() as { subscriptionId: string; priceUsd: number };
    expect(purchase2.priceUsd).toBe(49);
    const approve2 = await opPost("/v5/admin/billing/plans/approve", {
      subscriptionId: purchase2.subscriptionId,
      approve: true,
    });
    expect(approve2.statusCode).toBe(200);
    const renewedExpiry = (approve2.json() as { expiresAt: number }).expiresAt;
    expect(renewedExpiry).toBeGreaterThan(firstExpiry + 29 * 24 * 60 * 60);

    // Exactly one active row; the old one is superseded history.
    const rows = app.db
      .prepare("SELECT status, plan_code FROM app_subscriptions WHERE app_id = ? ORDER BY requested_at")
      .all(appRowId) as { status: string; plan_code: string }[];
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "superseded")).toHaveLength(1);
    expect(rows.find((r) => r.status === "active")?.plan_code).toBe("unlimited_5");
  });

  it("fails closed without a payment destination and validates the plan code", async () => {
    app = makeApp({ BKASH_PERSONAL_NUMBER: "" });
    seedApp("app_a");
    const noDest = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: CRED_A,
      payload: { planCode: "unlimited_1" },
    });
    expect(noDest.statusCode).toBe(503);
    expect(noDest.json().code).toBe("payment_destination_unconfigured");

    await app.close();
    app = makeApp();
    seedApp("app_a");
    const badCode = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: CRED_A,
      payload: { planCode: "unlimited_999" },
    });
    expect(badCode.statusCode).toBe(400);
    expect(badCode.json().code).toBe("invalid_plan_code");
  });

  it("one TrxID can fund only one subscription", async () => {
    app = makeApp();
    seedApp("app_a");
    seedApp("app_b");
    const buyA = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: CRED_A,
      payload: { planCode: "unlimited_1" },
    });
    const subA = (buyA.json() as { subscriptionId: string }).subscriptionId;
    const credB = { "x-app-id": "app_b", "x-app-secret": APP_SECRET };
    const buyB = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/purchase",
      headers: credB,
      payload: { planCode: "unlimited_1" },
    });
    const subB = (buyB.json() as { subscriptionId: string }).subscriptionId;

    const trxA = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/submit-trx",
      headers: CRED_A,
      payload: { subscriptionId: subA, trxId: "TRXUNIQ001" },
    });
    expect(trxA.statusCode).toBe(200);

    // Same TrxID on the other app's purchase → 409 trx_id_exists.
    const trxB = await app.inject({
      method: "POST",
      url: "/v5/billing/plans/submit-trx",
      headers: credB,
      payload: { subscriptionId: subB, trxId: "TRXUNIQ001" },
    });
    expect(trxB.statusCode).toBe(409);
    expect(trxB.json().code).toBe("trx_id_exists");
  });
});

describe("conditional credit bypass (anti-spoofing)", () => {
  it("BYOD send succeeds with 0 credits under an active plan + bound device", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });
    const enrolled = await enrollAppDevice("byod-phone");
    expect(enrolled.statusCode).toBe(201);

    // No credits row exists at all — the send must still succeed.
    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: CRED_A,
      payload: { phone: "+8801712345678" },
    });
    expect(send.statusCode).toBe(201);

    // Nothing was charged and the message is stamped for BYOD-only delivery.
    const credits = app.db
      .prepare("SELECT COUNT(*) AS n FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { n: number };
    expect(credits.n).toBe(0);
    const msg = app.db
      .prepare("SELECT unlimited_pass FROM pending_sms WHERE app_id = ? ORDER BY created_at DESC LIMIT 1")
      .get("app_a") as { unlimited_pass: number };
    expect(msg.unlimited_pass).toBe(1);
  });

  it("a subscribed app WITHOUT a bound device still pays for BD-pool sends", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    // Active plan, zero bound devices: the send would ride the dedicated BD
    // operator fleet → credits required, free-pass denied.
    seedSubscription(appRowId, { maxDevices: 1 });

    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: CRED_A,
      payload: { phone: "+8801712345679" },
    });
    expect(send.statusCode).toBe(402);
    expect(send.json().code).toBe("insufficient_credits");
  });

  it("an expired subscription fails closed even with a bound device", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, {
      maxDevices: 1,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const enrolled = await enrollAppDevice("byod-phone");
    expect(enrolled.statusCode).toBe(201);

    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: CRED_A,
      payload: { phone: "+8801712345680" },
    });
    expect(send.statusCode).toBe(402);
    expect(send.json().code).toBe("insufficient_credits");

    // The status endpoint reports the same fail-closed state to the dashboard.
    const status = await app.inject({ method: "GET", url: "/v5/billing/subscription", headers: CRED_A });
    expect((status.json() as { subscription: { active: boolean } }).subscription.active).toBe(false);
  });

  it("a paid send of a subscribed app stays fleet-eligible (unlimited_pass = 0)", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });
    // No bound device → charged; the operator fleet must be able to claim it.
    app.db
      .prepare(
        "INSERT INTO app_credits (app_id, otp_sms_remaining, otp_expires_at, updated_at) VALUES (?, 5, NULL, unixepoch())",
      )
      .run(appRowId);

    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: CRED_A,
      payload: { phone: "+8801712345681" },
    });
    expect(send.statusCode).toBe(201);
    const msg = app.db
      .prepare("SELECT unlimited_pass FROM pending_sms WHERE app_id = ? ORDER BY created_at DESC LIMIT 1")
      .get("app_a") as { unlimited_pass: number };
    expect(msg.unlimited_pass).toBe(0);
    const credits = app.db
      .prepare("SELECT otp_sms_remaining FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { otp_sms_remaining: number };
    expect(credits.otp_sms_remaining).toBe(4);
  });

  it("the BD fleet can never claim a free-pass message, even after the BYOD device is deleted", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });
    const enrolled = await enrollAppDevice("byod-phone");
    const byodKey = (enrolled.json() as { apiKey: string }).apiKey;

    const send = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: CRED_A,
      payload: { phone: "+8801712345682" },
    });
    expect(send.statusCode).toBe(201);
    const { deviceId } = enrolled.json() as { deviceId: string };

    // Operator-fleet device (global secret, no app binding) — the free-pass
    // message must be invisible to it once the BYOD device can't carry it.
    await app.inject({
      method: "DELETE",
      url: `/v5/apps/devices/${deviceId}`,
      headers: CRED_A,
    });
    const fleet = await app.inject({
      method: "POST",
      url: "/v5/device/enroll",
      headers: { authorization: `Bearer ${TEST_ENROLLMENT_SECRET}` },
      payload: { label: "operator fleet" },
    });
    expect(fleet.statusCode).toBe(201);
    const fleetKey = (fleet.json() as { apiKey: string }).apiKey;
    const fleetFetch = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${fleetKey}` },
    });
    expect((fleetFetch.json() as { messages: unknown[] }).messages).toHaveLength(0);

    // The owning app's replacement device DOES receive it (requeue semantics).
    const replacement = await enrollAppDevice("replacement");
    expect(replacement.statusCode).toBe(201);
    const replacementKey = (replacement.json() as { apiKey: string }).apiKey;
    const byodFetch = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${replacementKey}` },
    });
    expect((byodFetch.json() as { messages: unknown[] }).messages).toHaveLength(1);
    expect(byodKey).not.toBe(replacementKey);
  });
});

describe("bulk free-pass snapshot semantics", () => {
  const CSV = "+8801711000101\n+8801711000102";

  async function previewChecksumFor(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns/preview",
      headers: CRED_A,
      payload: { csv: CSV },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { checksum: string }).checksum;
  }

  it("reserves 0, refunds 0 and re-deducts 0 for a free-pass campaign", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });
    await enrollAppDevice("byod-phone");

    const checksum = await previewChecksumFor();
    const create = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: CRED_A,
      payload: { name: "free campaign", message: "hello", csv: CSV, checksum },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { campaignId: string; creditsReserved: number; unlimitedPass: boolean };
    expect(created.creditsReserved).toBe(0);
    expect(created.unlimitedPass).toBe(true);

    // Zero credits exist and none were minted by the free-pass.
    const credits = app.db
      .prepare("SELECT COUNT(*) AS n FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { n: number };
    expect(credits.n).toBe(0);

    // Cancelling a free-pass campaign must NOT mint credits.
    const cancel = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${created.campaignId}/cancel`,
      headers: CRED_A,
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { creditsRefunded: number }).creditsRefunded).toBe(0);
    const after = app.db
      .prepare("SELECT COUNT(*) AS n FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { n: number };
    expect(after.n).toBe(0);
  });

  it("still charges a subscribed app without a bound device (BD-pool route separation)", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    // Active plan but ZERO bound devices — and a real 0-balance credits row,
    // so the failure is the balance check, not a missing-row edge.
    seedSubscription(appRowId, { maxDevices: 1 });
    app.db
      .prepare("INSERT INTO app_credits (app_id, bulk_sms_remaining, updated_at) VALUES (?, 0, unixepoch())")
      .run(appRowId);
    const checksum = await previewChecksumFor();
    const create = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: CRED_A,
      payload: { name: "paid campaign", message: "hello", csv: CSV, checksum },
    });
    expect(create.statusCode).toBe(402);
    expect(create.json().code).toBe("insufficient_bulk_credits");
  });

  it("a free-pass campaign created before expiry keeps its snapshot on retry (no deduction)", async () => {
    app = makeApp();
    const appRowId = seedApp("app_a");
    seedSubscription(appRowId, { maxDevices: 1 });
    await enrollAppDevice("byod-phone");
    const checksum = await previewChecksumFor();
    const create = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: CRED_A,
      payload: { name: "snapshot campaign", message: "hello", csv: CSV, checksum },
    });
    const campaignId = (create.json() as { campaignId: string }).campaignId;

    // Force a failed recipient, then expire the subscription — the retry
    // must still not deduct (the creation-time snapshot governs).
    app.db
      .prepare("UPDATE bulk_recipients SET status = 'failed' WHERE campaign_id = ?")
      .run(campaignId);
    app.db
      .prepare("UPDATE app_subscriptions SET expires_at = ? WHERE app_id = ?")
      .run(Math.floor(Date.now() / 1000) - 60, appRowId);
    const retry = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${campaignId}/retry-failed`,
      headers: CRED_A,
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { creditsDeducted: number }).creditsDeducted).toBe(0);
    const credits = app.db
      .prepare("SELECT COUNT(*) AS n FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { n: number };
    expect(credits.n).toBe(0);
  });
});
