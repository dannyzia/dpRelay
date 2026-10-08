/**
 * Message-template route tests (Stage E, ISSUE-74 AC2): CRUD happy paths, the
 * requireApp auth gate, the 1600-char body cap, the ≤100/app count cap, and
 * list pagination — happy, auth-fail, and limit paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "mt-test-jwt-secret-0123456789abcdef0123456789ab";
const TEST_APP_ID = "app_mt_1";
const TEST_APP_SECRET = "mt-test-app-secret-0123456789abcdef0123456789ab";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-mt-test-")), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET, ...extra } });
}

function seedApp(app: FastifyInstance): void {
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, rate_max_per_phone, rate_window_sec, created_at) " +
        "VALUES ('mt-row-1', ?, ?, 'MT Test App', 3, 3600, unixepoch())",
    )
    .run(TEST_APP_ID, sha256Hex(TEST_APP_SECRET));
}

function appHeaders(secret = TEST_APP_SECRET): Record<string, string> {
  return { "x-app-id": TEST_APP_ID, "x-app-secret": secret };
}

let app: FastifyInstance;

beforeEach(() => {
  app = makeApp();
  seedApp(app);
});

afterEach(async () => {
  if (app) await app.close();
});

async function createTemplate(name: string, body: string) {
  return app.inject({
    method: "POST",
    url: "/v5/message-templates",
    headers: appHeaders(),
    payload: { name, body },
  });
}

describe("POST /v5/message-templates", () => {
  it("creates a template and reads it back", async () => {
    const res = await createTemplate("Welcome", "Your code is on the way");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.templateId).toBe("string");
    const detail = await app.inject({
      method: "GET",
      url: `/v5/message-templates/${body.templateId as string}`,
      headers: appHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().template).toMatchObject({
      templateId: body.templateId,
      name: "Welcome",
      body: "Your code is on the way",
    });
  });

  it("409s a duplicate name within the same app", async () => {
    expect((await createTemplate("Dup", "one")).statusCode).toBe(201);
    const again = await createTemplate("Dup", "two");
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("template_name_exists");
  });

  it("accepts a 1600-char body and rejects 1601 (storage cap)", async () => {
    const atLimit = await createTemplate("MaxBody", "x".repeat(1600));
    expect(atLimit.statusCode).toBe(201);
    const overLimit = await createTemplate("OverBody", "x".repeat(1601));
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json().code).toBe("invalid_template_body");
  });

  it("400s an over-long name and missing fields", async () => {
    const longName = await createTemplate("n".repeat(101), "body");
    expect(longName.statusCode).toBe(400);
    expect(longName.json().code).toBe("invalid_template_name");
    const missingBody = await app.inject({
      method: "POST",
      url: "/v5/message-templates",
      headers: appHeaders(),
      payload: { name: "NoBody" },
    });
    expect(missingBody.statusCode).toBe(400);
    expect(missingBody.json().code).toBe("invalid_template");
  });

  it("enforces the ≤100/app cap: 101st create is 409 template_limit", async () => {
    for (let i = 0; i < 100; i++) {
      const res = await createTemplate(`tmpl-${i}`, `body ${i}`);
      expect(res.statusCode).toBe(201);
    }
    const overflow = await createTemplate("one-too-many", "body");
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().code).toBe("template_limit");
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM message_templates").get() as { n: number };
    expect(count.n).toBe(100);
  }, 30_000);

  it("401s without credentials and with a wrong secret", async () => {
    const noCreds = await app.inject({
      method: "POST",
      url: "/v5/message-templates",
      payload: { name: "X", body: "Y" },
    });
    expect(noCreds.statusCode).toBe(401);
    expect(noCreds.json().code).toBe("missing_app_credentials");
    const wrong = await app.inject({
      method: "POST",
      url: "/v5/message-templates",
      headers: appHeaders("wrong-secret"),
      payload: { name: "X", body: "Y" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("invalid_app_secret");
  });
});

describe("GET /v5/message-templates (list)", () => {
  it("pages newest-first with a keyset cursor and yields every template exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await createTemplate(`T${i}`, `body ${i}`);
      expect(res.statusCode).toBe(201);
      ids.push(res.json().templateId as string);
      app.db.prepare("UPDATE message_templates SET created_at = ? WHERE id = ?").run(1000 + i, ids[i]);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = cursor === null
        ? "/v5/message-templates?limit=1"
        : `/v5/message-templates?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.inject({ method: "GET", url, headers: appHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { templates: { templateId: string }[]; nextCursor: string | null };
      seen.push(...body.templates.map((t) => t.templateId));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("401s without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/v5/message-templates" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v5/message-templates/:id (detail)", () => {
  it("404s unknown ids and 400s malformed ids", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/v5/message-templates/does-not-exist",
      headers: appHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("template_not_found");
    const malformed = await app.inject({
      method: "GET",
      url: `/v5/message-templates/${"x".repeat(65)}`,
      headers: appHeaders(),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("invalid_template_id");
  });
});

describe("PATCH /v5/message-templates/:id", () => {
  it("renames and replaces the body; conflicts and caps are enforced", async () => {
    const id = (await createTemplate("Editable", "first")).json().templateId as string;
    await createTemplate("Taken", "other");

    const updated = await app.inject({
      method: "PATCH",
      url: `/v5/message-templates/${id as string}`,
      headers: appHeaders(),
      payload: { name: "Edited", body: "second" },
    });
    expect(updated.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/v5/message-templates/${id as string}`,
      headers: appHeaders(),
    });
    expect(detail.json().template).toMatchObject({ name: "Edited", body: "second" });

    const conflict = await app.inject({
      method: "PATCH",
      url: `/v5/message-templates/${id as string}`,
      headers: appHeaders(),
      payload: { name: "Taken" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("template_name_exists");

    const overLimit = await app.inject({
      method: "PATCH",
      url: `/v5/message-templates/${id as string}`,
      headers: appHeaders(),
      payload: { body: "y".repeat(1601) },
    });
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json().code).toBe("invalid_template_body");

    const missing = await app.inject({
      method: "PATCH",
      url: "/v5/message-templates/nope",
      headers: appHeaders(),
      payload: { name: "Whatever" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("DELETE /v5/message-templates/:id", () => {
  it("deletes once, then 404s", async () => {
    const id = (await createTemplate("Doomed", "bye")).json().templateId as string;
    const res = await app.inject({
      method: "DELETE",
      url: `/v5/message-templates/${id}`,
      headers: appHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const again = await app.inject({
      method: "DELETE",
      url: `/v5/message-templates/${id}`,
      headers: appHeaders(),
    });
    expect(again.statusCode).toBe(404);
  });
});
