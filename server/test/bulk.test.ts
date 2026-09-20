/**
 * M4 pass 2 — bulk campaign plane tests (PLAN §10). Covers: create
 * validation + money atomicity (deduct + audit in one transaction, expired
 * and insufficient credits), the queue tick lifecycle (enqueue budget,
 * results reconcile with retry-then-fail, finalize + signed completion
 * webhook), cancellation refunding exactly once (v4 double-refund regression
 * pin), retry-failed re-deduction, pagination, app scoping, and the stats
 * snapshot.
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

const TEST_JWT_SECRET = "bulk-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_ENROLLMENT_SECRET = "enroll-only-secret-0123456789abcdef0123456789ab";
const WEBHOOK_SECRET = "whsec-0123456789abcdef0123456789abcdef";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-bulk-test-")), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET,
      BULK_ENABLED: "true",
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

/** Inserts an app row directly; returns the internal id (credits/app FK key). */
function seedApp(
  appId: string,
  appSecret: string,
  webhook: { url: string | null; secret: string | null } = { url: null, secret: null },
): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, " +
        "rate_max_per_phone, rate_window_sec, created_at) VALUES (?, ?, ?, 'Bulk App', ?, ?, 3, 3600, unixepoch())",
    )
    .run(id, appId, sha256Hex(appSecret), webhook.url, webhook.secret);
  return id;
}

function seedCredits(
  appRowId: string,
  bulk: number,
  opts: { bulkExpiresAt?: number } = {},
): void {
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, bulk_sms_remaining, bulk_expires_at, updated_at) VALUES (?, ?, ?, unixepoch())",
    )
    .run(appRowId, bulk, opts.bulkExpiresAt ?? null);
}

const CREDS = (appId: string, secret: string) => ({
  "x-app-id": appId,
  "x-app-secret": secret,
});

const SECRET_A = "bulk-app-secret-a-0123456789abcdef0123456789ab";
const PHONES = ["+8801711000001", "+8801711000002", "+8801711000003", "+8801711000004"];

interface SinkHit {
  body: string;
  signature: string | null;
}

/** Local HTTP sink capturing webhook POSTs; returns the URL + hits array. */
function startSink(): { url: string; hits: SinkHit[] } {
  const hits: SinkHit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ body, signature: (req.headers["x-dp-signature"] as string | undefined) ?? null });
      res.writeHead(200);
      res.end("ok");
    });
  });
  server.listen(0);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}/hook`, hits };
}

/** Enrolls a device via the public route; returns its API key. */
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

async function createCampaign(
  creds: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/v5/bulk/campaigns",
    headers: creds,
    payload: { campaignName: "Test campaign", message: "Hello from dP Relay", phones: PHONES, ...payload },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

function creditsRow(appRowId: string): { bulk_sms_remaining: number } {
  return app.db
    .prepare("SELECT bulk_sms_remaining FROM app_credits WHERE app_id = ?")
    .get(appRowId) as { bulk_sms_remaining: number };
}

function campaignRow(campaignId: string): Record<string, unknown> {
  return app.db
    .prepare(
      "SELECT id, status, total_recipients, sent_count, failed_count, queued_count, started_at, completed_at " +
        "FROM bulk_campaigns WHERE id = ?",
    )
    .get(campaignId) as unknown as Record<string, unknown>;
}

describe("POST /v5/bulk/campaigns — gating + validation", () => {
  it("403 bulk_not_enabled when the feature flag is off", async () => {
    app = makeApp({ BULK_ENABLED: "false" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const { statusCode, body } = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    expect(statusCode).toBe(403);
    expect(body.code).toBe("bulk_not_enabled");
  });

  it("rejects contact-group sources until the groups pass", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const { statusCode, body } = await createCampaign(CREDS("bulk_app", SECRET_A), {
      sourceType: "contactGroups",
      sourceGroupIds: ["g1"],
    });
    expect(statusCode).toBe(400);
    expect(body.code).toBe("contact_groups_not_available");
  });

  it("validates name, message charset caps, and E.164", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const creds = CREDS("bulk_app", SECRET_A);

    expect((await createCampaign(creds, { campaignName: "" })).statusCode).toBe(400);
    expect((await createCampaign(creds, { campaignName: "x".repeat(101) })).statusCode).toBe(400);
    // UCS-2 cap is 70 chars by default; 71 non-GSM chars must fail.
    expect((await createCampaign(creds, { message: "あ".repeat(71) })).statusCode).toBe(400);
    // GSM-7 cap is 160.
    expect((await createCampaign(creds, { message: "a".repeat(161) })).statusCode).toBe(400);
    expect((await createCampaign(creds, { message: "a".repeat(160) })).statusCode).toBe(201);
    expect((await createCampaign(creds, { phones: ["01711000001"] })).statusCode).toBe(400);
    expect((await createCampaign(creds, { phones: [] })).statusCode).toBe(400);
  });

  it("enforces the per-campaign recipient limit", async () => {
    app = makeApp({ BULK_SMS_PER_CAMPAIGN_LIMIT: "3" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const { statusCode, body } = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    expect(statusCode).toBe(400);
    expect(body.code).toBe("invalid_phones");
  });
});

describe("POST /v5/bulk/campaigns — money atomicity", () => {
  it("deducts unique recipients once, writes hashed audit rows, reports duplicates", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const { statusCode, body } = await createCampaign(CREDS("bulk_app", SECRET_A), {
      phones: [PHONES[0], PHONES[0], PHONES[1]],
    });
    expect(statusCode).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      totalRecipients: 2,
      creditsReserved: 2,
      duplicateCount: 1,
      charset: "gsm",
      status: "queued",
    });
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(98);

    const campaignId = body.campaignId as string;
    const usage = app.db.prepare("SELECT phone_hash FROM bulk_usage WHERE campaign_id = ?").all(campaignId) as {
      phone_hash: string;
    }[];
    expect(usage.map((u) => u.phone_hash).sort()).toEqual(uniqueSortedHashes([PHONES[0], PHONES[1]]));
    const recipients = app.db
      .prepare("SELECT status FROM bulk_recipients WHERE campaign_id = ?")
      .all(campaignId) as { status: string }[];
    expect(recipients).toHaveLength(2);
    expect(recipients.every((r) => r.status === "pending")).toBe(true);
  });

  it("402 insufficient_bulk_credits and creates NO campaign rows", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 1);
    const { statusCode, body } = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    expect(statusCode).toBe(402);
    expect(body.code).toBe("insufficient_bulk_credits");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bulk_campaigns").get()).toMatchObject({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bulk_usage").get()).toMatchObject({ n: 0 });
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(1);
  });

  it("402 credits_expired when bulk credits are past their expiry", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100, { bulkExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    const { statusCode, body } = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    expect(statusCode).toBe(402);
    expect(body.code).toBe("credits_expired");
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(100);
  });

  it("429 daily_quota_exceeded when the UTC-day budget is exhausted", async () => {
    app = makeApp({ BULK_DAILY_APP_LIMIT: "3" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const creds = CREDS("bulk_app", SECRET_A);
    expect((await createCampaign(creds, { phones: PHONES.slice(0, 2) })).statusCode).toBe(201);
    const { statusCode, body } = await createCampaign(creds, { phones: PHONES.slice(0, 2) });
    expect(statusCode).toBe(429);
    expect(body.code).toBe("daily_quota_exceeded");
  });
});

function uniqueSortedHashes(phones: string[]): string[] {
  return [...new Set(phones.map((p) => sha256Hex(p)))].sort();
}

describe("queue tick — enqueue budget + lifecycle", () => {
  it("enqueues under the per-minute rate, activates the campaign, and links rows", async () => {
    app = makeApp({ BULK_SMS_RATE_PER_MINUTE: "2" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const created = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    const campaignId = created.body.campaignId as string;

    const first = await app.runBulkQueueTick();
    expect(first.enqueued).toBe(2);
    let row = campaignRow(campaignId);
    expect(row.status).toBe("sending");
    expect(row.queued_count).toBe(2);
    expect(row.started_at).not.toBeNull();

    // In-flight rows count against the rate budget: the second half only
    // enqueues after the phone drains the first (backpressure, v4 parity).
    const apiKey = await enroll(app);
    const fetch1 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const messages = (fetch1.json() as { messages: { id: string }[] }).messages;
    expect(messages).toHaveLength(2);
    await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: messages.map((m) => ({ id: m.id, status: "sent" })) },
    });

    const second = await app.runBulkQueueTick();
    expect(second.enqueued).toBe(2);
    row = campaignRow(campaignId);
    expect(row.queued_count).toBe(4);

    const pending = app.db
      .prepare("SELECT app_id, to_addr, message, status FROM pending_sms")
      .all() as { app_id: string; to_addr: string; message: string; status: string }[];
    expect(pending).toHaveLength(4);
    // First two rows are 'sent' (reported), the second two are fresh 'pending'.
    expect(pending.every((p) => p.app_id === "bulk_app" && p.message === "Hello from dP Relay")).toBe(true);
    expect(pending.filter((p) => p.status === "sent")).toHaveLength(2);
    expect(pending.filter((p) => p.status === "pending")).toHaveLength(2);
  });

  it("skips paused campaigns and resumes them", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const created = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    const campaignId = created.body.campaignId as string;
    const creds = CREDS("bulk_app", SECRET_A);

    const paused = await app.inject({ method: "POST", url: `/v5/bulk/campaigns/${campaignId}/pause`, headers: creds });
    expect(paused.statusCode).toBe(200);
    expect((await app.runBulkQueueTick()).enqueued).toBe(0);

    const resumed = await app.inject({ method: "POST", url: `/v5/bulk/campaigns/${campaignId}/resume`, headers: creds });
    expect(resumed.statusCode).toBe(200);
    expect((await app.runBulkQueueTick()).enqueued).toBe(4);

    // Precondition guards for the state machine.
    expect(
      (await app.inject({ method: "POST", url: `/v5/bulk/campaigns/${campaignId}/pause`, headers: creds })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: `/v5/bulk/campaigns/${campaignId}/resume`, headers: creds })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: `/v5/bulk/campaigns/${campaignId}/resume`, headers: creds })).statusCode,
    ).toBe(409);
  });
});

describe("queue tick — results reconcile, retry, finalize + webhook", () => {
  it("marks sent, retries failures to the cap, finalizes, and signs the completion webhook", async () => {
    const sink = startSink();
    app = makeApp({ BULK_RETRY_MAX_ATTEMPTS: "2", WEBHOOK_RETRY_DELAYS_MS: "0,0" });
    const appRowId = seedApp("bulk_app", SECRET_A, { url: sink.url, secret: WEBHOOK_SECRET });
    seedCredits(appRowId, 100);
    const created = await createCampaign(CREDS("bulk_app", SECRET_A), { phones: [PHONES[0], PHONES[1]] });
    const campaignId = created.body.campaignId as string;
    const apiKey = await enroll(app);

    await app.runBulkQueueTick();

    // Phone claims both and reports: first sent, second failed twice (terminal).
    const fetch1 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const messages = (fetch1.json() as { messages: { id: string }[] }).messages;
    expect(messages).toHaveLength(2);
    const reported = await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        results: [
          { id: messages[0]!.id, status: "sent" },
          { id: messages[1]!.id, status: "failed", error: "NO_SERVICE" },
        ],
      },
    });
    expect(reported.statusCode).toBe(200);

    // Tick 1: sent closes recipient 1; failed #1 sends recipient 2 back to pending.
    let tick = await app.runBulkQueueTick();
    expect(tick.reconciled).toBe(2);
    expect(tick.enqueued).toBe(1); // retry of recipient 2
    let row = campaignRow(campaignId);
    expect(row.sent_count).toBe(1);
    expect(row.failed_count).toBe(0);

    // Tick 2: the retried recipient is enqueued again; the phone fails it again.
    const fetch2 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const retryMessages = (fetch2.json() as { messages: { id: string }[] }).messages;
    expect(retryMessages).toHaveLength(1);
    await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: retryMessages[0]!.id, status: "failed", error: "NO_SERVICE" }] },
    });

    // Tick 3: attempts hits the cap (2) → terminal failure → finalize + webhook.
    tick = await app.runBulkQueueTick();
    expect(tick.finalized).toBe(1);
    row = campaignRow(campaignId);
    expect(row.status).toBe("completed");
    expect(row.sent_count).toBe(1);
    expect(row.failed_count).toBe(1);
    expect(row.completed_at).not.toBeNull();

    // Webhook: exactly one hit, correct payload, valid hex HMAC signature.
    expect(sink.hits).toHaveLength(1);
    const hit = sink.hits[0]!;
    const payload = JSON.parse(hit.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "bulk.campaign.completed",
      appId: "bulk_app",
      campaignId,
      sentCount: 1,
      failedCount: 1,
      totalRecipients: 2,
    });
    const expectedSig = createHmac("sha256", WEBHOOK_SECRET).update(hit.body).digest("hex");
    expect(hit.signature).toBe(expectedSig);

    // Audit rows link the dispatch to the campaign.
    const deliveries = app.db
      .prepare("SELECT campaign_id, session_id, status FROM webhook_deliveries WHERE campaign_id = ?")
      .all(campaignId) as { campaign_id: string; session_id: string | null; status: string }[];
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries.every((d) => d.session_id === null && d.status === "delivered")).toBe(true);
  });

  it("completes silently when no webhook is configured", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const created = await createCampaign(CREDS("bulk_app", SECRET_A), { phones: [PHONES[0]] });
    const campaignId = created.body.campaignId as string;
    const apiKey = await enroll(app);

    await app.runBulkQueueTick();
    const fetch1 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const messages = (fetch1.json() as { messages: { id: string }[] }).messages;
    await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: messages[0]!.id, status: "sent" }] },
    });

    const tick = await app.runBulkQueueTick();
    expect(tick.finalized).toBe(1);
    expect(campaignRow(campaignId).status).toBe("completed");
  });

  it("arms the post-send cooldown and skips the same phone in later campaigns", async () => {
    app = makeApp({ BULK_POST_SEND_COOLDOWN_SEC: "300" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const creds = CREDS("bulk_app", SECRET_A);
    const apiKey = await enroll(app);

    const first = await createCampaign(creds, { phones: [PHONES[0]] });
    await app.runBulkQueueTick();
    const fetch1 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const messages = (fetch1.json() as { messages: { id: string }[] }).messages;
    await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: messages[0]!.id, status: "sent" }] },
    });
    await app.runBulkQueueTick();

    const second = await createCampaign(creds, { phones: [PHONES[0]] });
    const secondTick = await app.runBulkQueueTick();
    expect(secondTick.enqueued).toBe(0);
    const recipient = app.db
      .prepare("SELECT status FROM bulk_recipients WHERE campaign_id = ?")
      .get(second.body.campaignId as string) as { status: string };
    expect(recipient.status).toBe("pending"); // skipped, retried after cooldown
    expect(campaignRow(first.body.campaignId as string).status).toBe("completed");
  });
});

describe("cancel + retry-failed — money paths", () => {
  it("refunds unprocessed recipients EXACTLY once (v4 double-refund regression pin)", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const creds = CREDS("bulk_app", SECRET_A);
    const apiKey = await enroll(app);

    const created = await createCampaign(creds, {});
    const campaignId = created.body.campaignId as string;
    await app.runBulkQueueTick(); // all 4 queued
    const fetch1 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const messages = (fetch1.json() as { messages: { id: string }[] }).messages;
    // One delivered, three still in flight.
    await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { results: [{ id: messages[0]!.id, status: "sent" }] },
    });
    await app.runBulkQueueTick();

    const cancelled = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${campaignId}/cancel`,
      headers: creds,
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { creditsRefunded: number }).creditsRefunded).toBe(3);
    // 100 - 4 (create) + 3 (refund) = 99. The v4 bug would have refunded 6.
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(99);

    const statuses = app.db
      .prepare("SELECT status, COUNT(*) AS n FROM bulk_recipients WHERE campaign_id = ? GROUP BY status")
      .all(campaignId) as { status: string; n: number }[];
    expect(statuses).toEqual(
      expect.arrayContaining([
        { status: "sent", n: 1 },
        { status: "cancelled", n: 3 },
      ]),
    );
    // In-flight rows voided; the sent row stays as history.
    const remaining = app.db.prepare("SELECT COUNT(*) AS n FROM pending_sms").get() as { n: number };
    expect(remaining.n).toBe(1);
    expect(campaignRow(campaignId).status).toBe("cancelled");

    // Cancelling again is a 409, never a second refund.
    const twice = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${campaignId}/cancel`,
      headers: creds,
    });
    expect(twice.statusCode).toBe(409);
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(99);
  });

  it("retry-failed re-deducts credits, resets recipients, and reopens the campaign", async () => {
    app = makeApp({ BULK_RETRY_MAX_ATTEMPTS: "1" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const creds = CREDS("bulk_app", SECRET_A);
    const apiKey = await enroll(app);

    const created = await createCampaign(creds, { phones: [PHONES[0], PHONES[1]] });
    const campaignId = created.body.campaignId as string;
    await app.runBulkQueueTick();
    const fetch1 = await app.inject({
      method: "GET",
      url: "/v5/device/outstanding",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const messages = (fetch1.json() as { messages: { id: string }[] }).messages;
    await app.inject({
      method: "POST",
      url: "/v5/device/results",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        results: [
          { id: messages[0]!.id, status: "sent" },
          { id: messages[1]!.id, status: "failed", error: "NO_SERVICE" },
        ],
      },
    });
    await app.runBulkQueueTick(); // attempts hits cap 1 → terminal failure
    expect(campaignRow(campaignId).failed_count).toBe(1);
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(98);

    const retried = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${campaignId}/retry-failed`,
      headers: creds,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true, retryCount: 1, creditsDeducted: 1 });
    expect(creditsRow(appRowId).bulk_sms_remaining).toBe(97);
    const row = campaignRow(campaignId);
    expect(row.status).toBe("sending");
    expect(row.total_recipients).toBe(3); // v4 parity: total grows by the retry count

    const recipient = app.db
      .prepare("SELECT status, attempts FROM bulk_recipients WHERE campaign_id = ? AND status != 'sent'")
      .get(campaignId) as { status: string; attempts: number };
    expect(recipient).toMatchObject({ status: "pending", attempts: 0 });

    // Insufficient credits for the retry → 402, nothing reset.
    app.db.prepare("UPDATE app_credits SET bulk_sms_remaining = 0 WHERE app_id = ?").run(appRowId);
    const recipient2 = app.db
      .prepare("SELECT id FROM bulk_recipients WHERE campaign_id = ? AND status = 'pending'")
      .get(campaignId) as { id: string };
    app.db.prepare("UPDATE bulk_recipients SET status = 'failed' WHERE id = ?").run(recipient2.id);
    app.db.prepare("UPDATE bulk_campaigns SET status = 'completed' WHERE id = ?").run(campaignId);
    const poor = await app.inject({
      method: "POST",
      url: `/v5/bulk/campaigns/${campaignId}/retry-failed`,
      headers: creds,
    });
    expect(poor.statusCode).toBe(402);
  });
});

describe("list + status + scoping", () => {
  it("lists app-scoped campaigns with keyset pagination and status filter", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const creds = CREDS("bulk_app", SECRET_A);
    for (const name of ["one", "two", "three"]) {
      const r = await app.inject({
        method: "POST",
        url: "/v5/bulk/campaigns",
        headers: creds,
        payload: { campaignName: name, message: "m", phones: [PHONES[0]] },
      });
      expect(r.statusCode).toBe(201);
    }

    const page1 = await app.inject({ method: "GET", url: "/v5/bulk/campaigns?limit=2", headers: creds });
    const p1 = page1.json() as { campaigns: { name: string }[]; nextCursor: string | null };
    expect(p1.campaigns).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const page2 = await app.inject({
      method: "GET",
      url: `/v5/bulk/campaigns?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`,
      headers: creds,
    });
    const p2 = page2.json() as { campaigns: { name: string }[]; nextCursor: string | null };
    expect(p2.campaigns).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.campaigns, ...p2.campaigns].map((c) => c.name).sort()).toEqual(["one", "three", "two"]);

    const sending = await app.inject({
      method: "GET",
      url: "/v5/bulk/campaigns?status=sending",
      headers: creds,
    });
    expect((sending.json() as { campaigns: unknown[] }).campaigns).toHaveLength(0);
  });

  it("hides other apps' campaigns (404, not 403) and guards state transitions", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    seedApp("other_app", "other-app-secret-0123456789abcdef0123456789ab");
    const otherRowId = (app.db.prepare("SELECT id FROM apps WHERE app_id = 'other_app'").get() as { id: string }).id;
    seedCredits(otherRowId, 100);
    const created = await createCampaign(CREDS("bulk_app", SECRET_A), {});
    const campaignId = created.body.campaignId as string;

    const foreign = await app.inject({
      method: "GET",
      url: `/v5/bulk/campaigns/${campaignId}`,
      headers: CREDS("other_app", "other-app-secret-0123456789abcdef0123456789ab"),
    });
    expect(foreign.statusCode).toBe(404);

    const status = await app.inject({
      method: "GET",
      url: `/v5/bulk/campaigns/${campaignId}`,
      headers: CREDS("bulk_app", SECRET_A),
    });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { campaign: { totalRecipients: number } }).campaign.totalRecipients).toBe(4);
  });
});

describe("stats snapshot", () => {
  it("upserts the single-row stats snapshot", async () => {
    app = makeApp();
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    await createCampaign(CREDS("bulk_app", SECRET_A), {});

    app.runStatsTick();
    const row = app.db.prepare("SELECT payload FROM stats_current WHERE id = 1").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as { bulk: { campaignsToday: number } };
    expect(payload.bulk.campaignsToday).toBe(1);

    app.runStatsTick(); // upsert, never grows
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM stats_current").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
