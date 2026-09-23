/**
 * M4 pass 3 remainder — admin app-plane tests (PLAN §10): the operator gate
 * (401/503 matrix), registration (generated vs supplied secrets, validation),
 * listing without secret exposure, the full revoke → app_revoked → unrevoke
 * lifecycle exercised through a real requireApp route, webhook-secret
 * rotation (hash correctness + rotation stamp), and webhook URL updates.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "admin-test-jwt-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "operator-test-secret-0123456789abcdef0123456789ab";
const SECRET_A = "admin-app-secret-a-0123456789abcdef0123456789ab";

const OP = { Authorization: "Bearer " + TEST_OPERATOR_SECRET };

function makeApp(extra: Record<string, string> = {}, omitOperator = false): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-admin-test-")), "test.db");
  const env: Record<string, string> = { JWT_SECRET: TEST_JWT_SECRET, ...extra };
  if (!omitOperator) env.OPERATOR_SECRET = TEST_OPERATOR_SECRET;
  return buildApp({ dbPath, env });
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

describe("operator gate", () => {
  it("401s every admin route without or with a wrong secret", async () => {
    app = makeApp();
    for (const [method, url] of [
      ["POST", "/v5/admin/apps"],
      ["GET", "/v5/admin/apps"],
      ["POST", "/v5/admin/apps/whatever/revoke"],
      ["POST", "/v5/admin/apps/whatever/unrevoke"],
      ["POST", "/v5/admin/apps/whatever/rotate-webhook-secret"],
      ["PATCH", "/v5/admin/apps/whatever/webhook"],
    ] as const) {
      const none = await app.inject({ method, url, headers: {}, payload: {} });
      expect(none.statusCode, `${method} ${url} without secret`).toBe(401);
      expect((none.json() as { code: string }).code).toBe("invalid_operator_secret");
      const wrong = await app.inject({ method, url, headers: { Authorization: "Bearer nope-nope-nope-nope-nope-nope-nope" }, payload: {} });
      expect(wrong.statusCode, `${method} ${url} with wrong secret`).toBe(401);
    }
  });

  it("503s fail-closed when OPERATOR_SECRET is unset", async () => {
    app = makeApp({}, true);
    const r = await app.inject({ method: "GET", url: "/v5/admin/apps", headers: { Authorization: "Bearer anything-at-all-0123456789abcdef" } });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { code: string }).code).toBe("admin_disabled");
  });
});

describe("POST /v5/admin/apps", () => {
  it("registers with a server-generated secret and returns it exactly once", async () => {
    app = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v5/admin/apps",
      headers: OP,
      payload: { appId: "generated-app", webhookUrl: "https://example.com/hook" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      id: string; appId: string; appSecret?: string; appSecretGenerated: boolean; webhookSecret: string; webhookUrl: string | null;
    };
    expect(body.appId).toBe("generated-app");
    expect(body.appSecretGenerated).toBe(true);
    expect(body.appSecret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(body.webhookSecret).toMatch(/^\S{32,}$/);
    expect(body.webhookUrl).toBe("https://example.com/hook");
    // Hash-only at rest.
    const row = app.db.prepare("SELECT app_secret_hash, webhook_secret_hash FROM apps WHERE id = ?").get(body.id) as {
      app_secret_hash: string; webhook_secret_hash: string;
    };
    expect(row.app_secret_hash).toBe(sha256Hex(body.appSecret!));
    expect(row.webhook_secret_hash).toBe(sha256Hex(body.webhookSecret));
  });

  it("registers with a supplied secret, echoes it once, and validates input", async () => {
    app = makeApp();
    const ok = await app.inject({
      method: "POST", url: "/v5/admin/apps", headers: OP,
      payload: { appId: "supplied-app", appSecret: SECRET_A },
    });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { appSecret: string }).appSecret).toBe(SECRET_A);

    const dup = await app.inject({ method: "POST", url: "/v5/admin/apps", headers: OP, payload: { appId: "supplied-app" } });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { code: string }).code).toBe("app_id_exists");

    const badId = await app.inject({ method: "POST", url: "/v5/admin/apps", headers: OP, payload: { appId: "x" } });
    expect(badId.statusCode).toBe(400);
    const shortSecret = await app.inject({
      method: "POST", url: "/v5/admin/apps", headers: OP,
      payload: { appId: "short-secret-app", appSecret: "too-short" },
    });
    expect(shortSecret.statusCode).toBe(400);
    const httpHook = await app.inject({
      method: "POST", url: "/v5/admin/apps", headers: OP,
      payload: { appId: "http-hook-app", webhookUrl: "http://insecure.example.com/hook" },
    });
    expect(httpHook.statusCode).toBe(400);
    expect((httpHook.json() as { code: string }).code).toBe("invalid_webhook_url");
  });
});

describe("GET /v5/admin/apps", () => {
  it("lists apps with no secret material in the payload", async () => {
    app = makeApp();
    seedApp("listed-app", SECRET_A);
    const r = await app.inject({ method: "GET", url: "/v5/admin/apps", headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { apps: Record<string, unknown>[] };
    expect(body.apps.length).toBeGreaterThanOrEqual(1);
    const row = body.apps.find((a) => a.appId === "listed-app")!;
    expect(row).toBeDefined();
    expect(Object.keys(row)).not.toContain("appSecret");
    expect(Object.keys(row)).not.toContain("webhookSecret");
    expect(Object.keys(row)).not.toContain("app_secret_hash");
  });
});

describe("revoke lifecycle", () => {
  it("revokes → app plane 401 app_revoked → unrevoke → access restored", async () => {
    app = makeApp();
    const AH = { "X-App-Id": "lifecycle-app", "X-App-Secret": SECRET_A };
    const rowId = seedApp("lifecycle-app", SECRET_A);

    // Baseline: app plane works (credits route is requireApp).
    const before = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: AH });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({ method: "POST", url: `/v5/admin/apps/${rowId}/revoke`, headers: OP });
    expect(revoke.statusCode).toBe(200);
    expect((revoke.json() as { revokedAt: number }).revokedAt).toBeGreaterThan(0);

    const during = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: AH });
    expect(during.statusCode).toBe(401);
    expect((during.json() as { code: string }).code).toBe("app_revoked");

    const again = await app.inject({ method: "POST", url: `/v5/admin/apps/${rowId}/revoke`, headers: OP });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe("already_revoked");

    const unrevoke = await app.inject({ method: "POST", url: `/v5/admin/apps/${rowId}/unrevoke`, headers: OP });
    expect(unrevoke.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v5/billing/credits", headers: AH });
    expect(after.statusCode).toBe(200);

    const notRevoked = await app.inject({ method: "POST", url: `/v5/admin/apps/${rowId}/unrevoke`, headers: OP });
    expect(notRevoked.statusCode).toBe(409);
    expect((notRevoked.json() as { code: string }).code).toBe("not_revoked");

    const missing = await app.inject({ method: "POST", url: "/v5/admin/apps/no-such-id/revoke", headers: OP });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe("admin_app_not_found");
  });
});

describe("rotate-webhook-secret + webhook update", () => {
  it("rotates the secret: new value returned once, hash + rotated_at updated", async () => {
    app = makeApp();
    const rowId = seedApp("rotate-app", SECRET_A);
    const oldHash = (app.db.prepare("SELECT webhook_secret_hash FROM apps WHERE id = ?").get(rowId) as { webhook_secret_hash: string }).webhook_secret_hash;

    const r = await app.inject({ method: "POST", url: `/v5/admin/apps/${rowId}/rotate-webhook-secret`, headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { webhookSecret: string; rotatedAt: number };
    expect(body.webhookSecret).toMatch(/^\S{32,}$/);
    expect(body.rotatedAt).toBeGreaterThan(0);

    const row = app.db.prepare("SELECT webhook_secret, webhook_secret_hash, webhook_rotated_at FROM apps WHERE id = ?").get(rowId) as {
      webhook_secret: string; webhook_secret_hash: string; webhook_rotated_at: number;
    };
    expect(row.webhook_secret).toBe(body.webhookSecret);
    expect(row.webhook_secret_hash).toBe(sha256Hex(body.webhookSecret));
    expect(row.webhook_secret_hash).not.toBe(oldHash);
    expect(row.webhook_rotated_at).not.toBeNull();

    const missing = await app.inject({ method: "POST", url: "/v5/admin/apps/no-such-id/rotate-webhook-secret", headers: OP });
    expect(missing.statusCode).toBe(404);
  });

  it("updates and clears the webhook URL (HTTPS-only)", async () => {
    app = makeApp();
    const rowId = seedApp("webhook-app", SECRET_A);

    const set = await app.inject({
      method: "PATCH", url: `/v5/admin/apps/${rowId}/webhook`, headers: OP,
      payload: { webhookUrl: "https://new.example.com/hooks" },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { webhookUrl: string }).webhookUrl).toBe("https://new.example.com/hooks");

    const insecure = await app.inject({
      method: "PATCH", url: `/v5/admin/apps/${rowId}/webhook`, headers: OP,
      payload: { webhookUrl: "http://new.example.com/hooks" },
    });
    expect(insecure.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH", url: `/v5/admin/apps/${rowId}/webhook`, headers: OP, payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const clear = await app.inject({
      method: "PATCH", url: `/v5/admin/apps/${rowId}/webhook`, headers: OP, payload: { webhookUrl: "" },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { webhookUrl: string | null }).webhookUrl).toBeNull();
    const stored = (app.db.prepare("SELECT webhook_url FROM apps WHERE id = ?").get(rowId) as { webhook_url: string | null }).webhook_url;
    expect(stored).toBeNull();
  });
});
