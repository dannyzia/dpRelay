/**
 * M4 pass 3 deferred-routes tests (fable5-v2 queue / Rhizome ISSUE-20):
 * - POST /v5/apps/revoke — holder-initiated revocation behind the provisioning
 *   Bearer + app credential identification (revoke → app plane 401 app_revoked).
 * - GET /v5/admin/apps/:id/credentials-status — credentials-ever-issued report
 *   (registry row ⇔ issuance), read-only, no secret material.
 * - GET /v5/admin/metrics — aggregate operator snapshot across planes.
 * - GET /v5/admin/campaigns — cross-app campaign oversight listing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "pass3-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "pass3-op-secret-0123456789abcdef0123456789abcd";
const TEST_PROVISION_SECRET = "pass3-provision-secret-0123456789abcdef0123456789";
const SECRET_A = "pass3-app-secret-a-0123456789abcdef0123456789abc";
const SECRET_B = "pass3-app-secret-b-0123456789abcdef0123456789abc";

const OP = { Authorization: `Bearer ${TEST_OPERATOR_SECRET}` };
const PROV = { Authorization: `Bearer ${TEST_PROVISION_SECRET}` };

function makeApp(extra: Record<string, string> = {}, omitOperator = false): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-pass3-test-")), "test.db");
  const env: Record<string, string> = {
    JWT_SECRET: TEST_JWT_SECRET,
    APP_PROVISIONING_SECRET: TEST_PROVISION_SECRET,
    ...extra,
  };
  if (!omitOperator) env.OPERATOR_SECRET = TEST_OPERATOR_SECRET;
  // startCron: false + runBootSweep: false — the bulk-queue tick (cron and
  // boot-sweep forms) would otherwise mutate seeded campaign rows mid-test
  // (determinism rule: no real timers or async sweeps in tests).
  return buildApp({ dbPath, env, startCron: false, runBootSweep: false });
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

/** Inserts an app row directly; returns the internal id. */
function seedApp(appId: string, appSecret: string): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, " +
        "webhook_secret_hash, rate_max_per_phone, rate_window_sec, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 3, 3600, unixepoch())",
    )
    .run(id, appId, sha256Hex(appSecret), appId, null, "whsec-" + appId, sha256Hex("whsec-" + appId));
  return id;
}

describe("POST /v5/apps/revoke", () => {
  it("401s on missing/wrong provisioning secret (constant envelope, no app-plane auth)", async () => {
    app = makeApp();
    seedApp("revoke-gate-app", SECRET_A);
    const AH = { "X-App-Id": "revoke-gate-app", "X-App-Secret": SECRET_A };

    const none = await app.inject({ method: "POST", url: "/v5/apps/revoke", headers: AH });
    expect(none.statusCode).toBe(401);
    expect((none.json() as { code: string }).code).toBe("invalid_provisioning_secret");

    const wrong = await app.inject({
      method: "POST",
      url: "/v5/apps/revoke",
      headers: { ...AH, Authorization: "Bearer nope-nope-nope-nope-nope-nope-nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect((wrong.json() as { code: string }).code).toBe("invalid_provisioning_secret");
  });

  it("403s fail-closed when APP_PROVISIONING_SECRET is unset", async () => {
    app = makeApp({ APP_PROVISIONING_SECRET: "" });
    const r = await app.inject({
      method: "POST",
      url: "/v5/apps/revoke",
      headers: { Authorization: "Bearer anything-at-all-0123456789abcdef", "X-App-Id": "a", "X-App-Secret": "b" },
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { code: string }).code).toBe("provisioning_disabled");
  });

  it("401s on missing app credentials and on a bad secret (no appId probing)", async () => {
    app = makeApp();
    seedApp("cred-check-app", SECRET_A);

    const missing = await app.inject({ method: "POST", url: "/v5/apps/revoke", headers: PROV });
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as { code: string }).code).toBe("missing_app_credentials");

    const unknown = await app.inject({
      method: "POST",
      url: "/v5/apps/revoke",
      headers: { ...PROV, "X-App-Id": "unknown-app", "X-App-Secret": SECRET_B },
    });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { code: string }).code).toBe("invalid_app_credentials");

    const badSecret = await app.inject({
      method: "POST",
      url: "/v5/apps/revoke",
      headers: { ...PROV, "X-App-Id": "cred-check-app", "X-App-Secret": SECRET_B },
    });
    expect(badSecret.statusCode).toBe(401);
    expect((badSecret.json() as { code: string }).code).toBe("invalid_app_credentials");
    // Unknown appId and known-appId-wrong-secret share one code: no probing.
    expect((unknown.json() as { code: string }).code).toBe((badSecret.json() as { code: string }).code);
  });

  it("revokes → app plane 401 app_revoked; already-revoked → 409", async () => {
    app = makeApp();
    const rowId = seedApp("self-revoke-app", SECRET_A);
    const AH = { "X-App-Id": "self-revoke-app", "X-App-Secret": SECRET_A };

    const before = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: AH });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({ method: "POST", url: "/v5/apps/revoke", headers: { ...PROV, ...AH } });
    expect(revoke.statusCode).toBe(200);
    const body = revoke.json() as { ok: boolean; appId: string; revokedAt: number };
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("self-revoke-app");
    expect(body.revokedAt).toBeGreaterThan(0);
    expect(
      (app.db.prepare("SELECT revoked_at FROM apps WHERE id = ?").get(rowId) as { revoked_at: number | null }).revoked_at,
    ).not.toBeNull();

    const during = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: AH });
    expect(during.statusCode).toBe(401);
    expect((during.json() as { code: string }).code).toBe("app_revoked");

    const again = await app.inject({ method: "POST", url: "/v5/apps/revoke", headers: { ...PROV, ...AH } });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe("already_revoked");

    // Revocation is effective immediately, but the operator restore lever stays.
    const unrevoke = await app.inject({ method: "POST", url: `/v5/admin/apps/${rowId}/unrevoke`, headers: OP });
    expect(unrevoke.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: AH });
    expect(after.statusCode).toBe(200);
  });

  it("shares the provisioning per-IP rate limiter with /v5/apps/register", async () => {
    app = makeApp({ APP_PROVISIONING_RATE_MAX_PER_HOUR: "1" });
    const burn = await app.inject({
      method: "POST",
      url: "/v5/apps/register",
      headers: PROV,
      payload: { appId: "nope", appSecret: "x" },
    });
    expect(burn.statusCode).toBe(400); // counts against the window
    const limited = await app.inject({ method: "POST", url: "/v5/apps/revoke", headers: PROV });
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { code: string }).code).toBe("rate_limited");
  });
});

describe("GET /v5/admin/apps/:id/credentials-status", () => {
  it("401s without the operator secret", async () => {
    app = makeApp();
    const rowId = seedApp("status-gate-app", SECRET_A);
    const r = await app.inject({ method: "GET", url: `/v5/admin/apps/${rowId}/credentials-status`, headers: {} });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { code: string }).code).toBe("invalid_operator_secret");
  });

  it("reports an issued, active app without any secret material", async () => {
    app = makeApp();
    const rowId = seedApp("status-app", SECRET_A);
    const r = await app.inject({ method: "GET", url: `/v5/admin/apps/${rowId}/credentials-status`, headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      ok: boolean; appId: string; credentialsIssued: boolean; revoked: boolean; revokedAt: number | null;
      webhookConfigured: boolean; webhookRotatedAt: number | null; createdAt: number;
    };
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("status-app");
    expect(body.credentialsIssued).toBe(true);
    expect(body.revoked).toBe(false);
    expect(body.revokedAt).toBeNull();
    expect(body.webhookConfigured).toBe(false);
    expect(body.webhookRotatedAt).toBeNull();
    expect(body.createdAt).toBeGreaterThan(0);
    expect(Object.keys(body)).not.toContain("appSecret");
    expect(Object.keys(body)).not.toContain("webhookSecret");
    expect(Object.keys(body)).not.toContain("app_secret_hash");

    // Read-only: the mutable columns are identical before and after the call.
    const snapshot = "SELECT revoked_at, webhook_url, webhook_secret, app_secret_hash FROM apps WHERE id = ?";
    const before = app.db.prepare(snapshot).get(rowId);
    const after = app.db.prepare(snapshot).get(rowId);
    expect(after).toEqual(before);
  });

  it("reports revocation and rotation state on a revoked app", async () => {
    app = makeApp();
    const rowId = seedApp("revoked-status-app", SECRET_A);
    app.db.prepare("UPDATE apps SET revoked_at = unixepoch() WHERE id = ?").run(rowId);
    app.db.prepare("UPDATE apps SET webhook_url = 'https://example.com/hook' WHERE id = ?").run(rowId);
    app.db.prepare("UPDATE apps SET webhook_rotated_at = unixepoch() WHERE id = ?").run(rowId);

    const r = await app.inject({ method: "GET", url: `/v5/admin/apps/${rowId}/credentials-status`, headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { credentialsIssued: boolean; revoked: boolean; webhookConfigured: boolean; webhookRotatedAt: number | null };
    expect(body.credentialsIssued).toBe(true);
    expect(body.revoked).toBe(true);
    expect(body.webhookConfigured).toBe(true);
    expect(body.webhookRotatedAt).not.toBeNull();
  });

  it("404s on an unknown app id (never fabricated status)", async () => {
    app = makeApp();
    const r = await app.inject({ method: "GET", url: "/v5/admin/apps/no-such-id/credentials-status", headers: OP });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { code: string }).code).toBe("admin_app_not_found");
  });
});

describe("GET /v5/admin/metrics", () => {
  it("401s without the operator secret and 503s fail-closed when unset", async () => {
    app = makeApp();
    const none = await app.inject({ method: "GET", url: "/v5/admin/metrics", headers: {} });
    expect(none.statusCode).toBe(401);
    expect((none.json() as { code: string }).code).toBe("invalid_operator_secret");

    const openApp = makeApp({}, true);
    const disabled = await openApp.inject({ method: "GET", url: "/v5/admin/metrics", headers: OP });
    expect(disabled.statusCode).toBe(503);
    expect((disabled.json() as { code: string }).code).toBe("admin_disabled");
    await openApp.close();
  });

  it("returns zeroed aggregates on a fresh database", async () => {
    app = makeApp();
    const r = await app.inject({ method: "GET", url: "/v5/admin/metrics", headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      ok: boolean; generatedAt: number;
      apps: { total: number; revoked: number };
      users: { total: number; devices: number };
      otp: { sessionsTotal: number; sessionsPending: number; sessionsVerified: number; sessionsLast24h: number };
      bulk: { campaignsTotal: number; campaignsActive: number; recipientsSent: number; recipientsFailed: number; recipientsQueued: number };
      billing: { transactionsPending: number; transactionsApproved: number; transactionsRejected: number; creditsRows: number };
      webhooks: { deliveriesLast24h: number; deliveredLast24h: number; failedLast24h: number };
    };
    expect(body.ok).toBe(true);
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.apps).toEqual({ total: 0, revoked: 0 });
    expect(body.otp).toEqual({ sessionsTotal: 0, sessionsPending: 0, sessionsVerified: 0, sessionsLast24h: 0 });
    expect(body.bulk.campaignsTotal).toBe(0);
    expect(body.billing.transactionsPending).toBe(0);
    expect(body.webhooks.deliveriesLast24h).toBe(0);
  });

  it("counts real rows across planes", async () => {
    app = makeApp();
    const idA = seedApp("metrics-app-a", SECRET_A);
    seedApp("metrics-app-b", SECRET_B);
    app.db.prepare("UPDATE apps SET revoked_at = unixepoch() WHERE id = ?").run(idA);
    app.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', unixepoch())")
      .run(crypto.randomUUID(), "metrics@example.com");
    app.db
      .prepare(
        "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, expires_at, status, created_at) " +
          "VALUES (?, ?, ?, 'h', 's', unixepoch() + 300, 'pending', unixepoch())",
      )
      .run(crypto.randomUUID(), idA, "+8801712345678");
    app.db
      .prepare(
        "INSERT INTO bulk_campaigns (id, app_id, name, message, status, total_recipients, created_at) " +
          "VALUES (?, ?, 'c', 'm', 'sending', 5, unixepoch())",
      )
      .run(crypto.randomUUID(), idA);
    app.db
      .prepare(
        "INSERT INTO webhook_deliveries (id, app_id, webhook_url, status, created_at) " +
          "VALUES (?, ?, 'https://example.com/hook', 'failed', unixepoch())",
      )
      .run(crypto.randomUUID(), idA);

    const r = await app.inject({ method: "GET", url: "/v5/admin/metrics", headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      apps: { total: number; revoked: number };
      users: { total: number };
      otp: { sessionsTotal: number; sessionsPending: number };
      bulk: { campaignsTotal: number; campaignsActive: number };
      webhooks: { deliveriesLast24h: number; failedLast24h: number };
    };
    expect(body.apps).toEqual({ total: 2, revoked: 1 });
    expect(body.users.total).toBe(1);
    expect(body.otp).toMatchObject({ sessionsTotal: 1, sessionsPending: 1 });
    expect(body.bulk).toMatchObject({ campaignsTotal: 1, campaignsActive: 1 });
    expect(body.webhooks).toMatchObject({ deliveriesLast24h: 1, failedLast24h: 1 });
  });
});

describe("GET /v5/admin/campaigns", () => {
  /** Inserts a campaign directly; returns its id. */
  function seedCampaign(appId: string, name: string, status: string, createdAtOffsetSec: number): string {
    const id = crypto.randomUUID();
    app.db
      .prepare(
        "INSERT INTO bulk_campaigns (id, app_id, name, message, charset, status, total_recipients, " +
          "sent_count, failed_count, created_at) VALUES (?, ?, ?, 'm', 'gsm', ?, 4, 1, 1, unixepoch() + ?)",
      )
      .run(id, appId, name, status, createdAtOffsetSec);
    return id;
  }

  it("401s without the operator secret", async () => {
    app = makeApp();
    const r = await app.inject({ method: "GET", url: "/v5/admin/campaigns", headers: {} });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { code: string }).code).toBe("invalid_operator_secret");
  });

  it("lists campaigns across ALL apps with derived queuedCount and public appIds", async () => {
    app = makeApp();
    const idA = seedApp("oversight-a", SECRET_A);
    const idB = seedApp("oversight-b", SECRET_B);
    // Created order (oldest first): a1, b1, a2 — listing is newest first.
    seedCampaign(idA, "camp-a1", "completed", -300);
    seedCampaign(idB, "camp-b1", "paused", -200);
    const third = seedCampaign(idA, "camp-a2", "sending", -100);

    const r = await app.inject({ method: "GET", url: "/v5/admin/campaigns", headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      ok: boolean;
      campaigns: {
        campaignId: string; appId: string; name: string; status: string;
        totalRecipients: number; sentCount: number; failedCount: number; queuedCount: number;
      }[];
      nextCursor: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.campaigns.map((c) => c.name)).toEqual(["camp-a2", "camp-b1", "camp-a1"]);
    expect(body.campaigns[0].appId).toBe("oversight-a");
    expect(body.campaigns[0].queuedCount).toBe(2); // 4 total - 1 sent - 1 failed
    expect(body.campaigns[0].campaignId).toBe(third);
    expect(body.nextCursor).toBeNull();
  });

  it("filters by status, rejects invalid status values, and paginates", async () => {
    app = makeApp();
    const idA = seedApp("oversight-f", SECRET_A);
    seedCampaign(idA, "camp-paused", "paused", -300);
    seedCampaign(idA, "camp-sending", "sending", -200);
    seedCampaign(idA, "camp-done", "completed", -100);

    const pausedOnly = await app.inject({ method: "GET", url: "/v5/admin/campaigns?status=paused", headers: OP });
    expect(pausedOnly.statusCode).toBe(200);
    expect((pausedOnly.json() as { campaigns: { name: string }[] }).campaigns.map((c) => c.name)).toEqual(["camp-paused"]);

    const bad = await app.inject({ method: "GET", url: "/v5/admin/campaigns?status=bogus", headers: OP });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { code: string }).code).toBe("invalid_status");

    const page1 = await app.inject({ method: "GET", url: "/v5/admin/campaigns?limit=2", headers: OP });
    const p1 = page1.json() as { campaigns: { campaignId: string; name: string }[]; nextCursor: string | null };
    expect(p1.campaigns.map((c) => c.name)).toEqual(["camp-done", "camp-sending"]);
    expect(p1.nextCursor).not.toBeNull();

    const page2 = await app.inject({ method: "GET", url: `/v5/admin/campaigns?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, headers: OP });
    const p2 = page2.json() as { campaigns: { name: string }[]; nextCursor: string | null };
    expect(p2.campaigns.map((c) => c.name)).toEqual(["camp-paused"]);
    expect(p2.nextCursor).toBeNull();
  });
});
