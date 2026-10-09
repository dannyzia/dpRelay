/**
 * STAGE F3 amendment (ISSUE-82): operator mail-config routes.
 * Covers the ordered invariants: password write-only (never returned, masked
 * as ••••), encrypted at rest, no SMTP env vars involved, and the test-send
 * button's structured failure mapping. SMTP send is exercised against a
 * refused loopback port — no real network egress.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const OPERATOR = "test-operator-secret-0123456789abcdef";
const SMTP_PASSWORD = "super-secret-smtp-password";

let app: FastifyInstance;

function makeApp(): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-mail-test-")), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, OPERATOR_SECRET: OPERATOR },
  });
}

function operatorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${OPERATOR}`, ...extra };
}

const VALID_CONFIG = {
  host: "smtp.example.test",
  port: 465,
  username: "mailer@example.test",
  password: SMTP_PASSWORD,
  fromAddress: "mailer@example.test",
};

beforeAll(async () => {
  app = makeApp();
});

afterAll(async () => {
  await app.close();
});

describe("GET /v5/admin/mail-config (masked)", () => {
  it("reports unconfigured state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, configured: false, passwordMasked: null });
  });

  it("requires the operator secret", async () => {
    const res = await app.inject({ method: "GET", url: "/v5/admin/mail-config" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PUT /v5/admin/mail-config (write-only password)", () => {
  it("validates the input shape", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
      payload: { ...VALID_CONFIG, port: 70000 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "invalid_mail_config" });

    const firstSaveWithoutPassword = await app.inject({
      method: "PUT",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
      payload: { host: "h", port: 465, username: "u", fromAddress: "f@example.test" },
    });
    expect(firstSaveWithoutPassword.statusCode).toBe(400);
  });

  it("saves the config, masks the password, and stores ciphertext only", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
      payload: VALID_CONFIG,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      configured: true,
      host: "smtp.example.test",
      port: 465,
      fromAddress: "mailer@example.test",
      passwordMasked: "••••",
    });
    // Ordered invariant: the password never appears in ANY GET/PUT response.
    expect(JSON.stringify(res.json())).not.toContain(SMTP_PASSWORD);

    const stored = app.db.prepare("SELECT password_encrypted, username FROM mail_config WHERE id = 1").get() as {
      password_encrypted: string;
      username: string;
    };
    expect(stored.password_encrypted.startsWith("v1:")).toBe(true);
    expect(stored.password_encrypted).not.toContain(SMTP_PASSWORD);
    expect(stored.username).toBe("mailer@example.test");
  });

  it("keeps the stored password when PUT omits it (write-only semantics)", async () => {
    const before = app.db.prepare("SELECT password_encrypted FROM mail_config WHERE id = 1").get() as {
      password_encrypted: string;
    };
    const res = await app.inject({
      method: "PUT",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
      payload: { host: "smtp2.example.test", port: 587, username: "u2@example.test", fromAddress: "f2@example.test" },
    });
    expect(res.statusCode).toBe(200);
    const after = app.db.prepare("SELECT password_encrypted FROM mail_config WHERE id = 1").get() as {
      password_encrypted: string;
    };
    expect(after.password_encrypted).toBe(before.password_encrypted);
    expect(res.json()).toMatchObject({ host: "smtp2.example.test", port: 587 });
  });
});

describe("POST /v5/admin/mail-config/test", () => {
  it("rejects before configuration exists", async () => {
    app.db.prepare("DELETE FROM mail_config").run();
    const res = await app.inject({
      method: "POST",
      url: "/v5/admin/mail-config/test",
      headers: operatorHeaders(),
      payload: { to: "operator@example.test" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "mail_not_configured" });
  });

  it("validates the target address", async () => {
    await app.inject({
      method: "PUT",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
      payload: VALID_CONFIG,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v5/admin/mail-config/test",
      headers: operatorHeaders(),
      payload: { to: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("maps a refused SMTP connection to a structured 502 (no crash, no hang)", async () => {
    // 127.0.0.1:9 → instant ECONNREFUSED; nothing leaves the machine.
    await app.inject({
      method: "PUT",
      url: "/v5/admin/mail-config",
      headers: operatorHeaders(),
      payload: { ...VALID_CONFIG, host: "127.0.0.1", port: 9 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v5/admin/mail-config/test",
      headers: operatorHeaders(),
      payload: { to: "operator@example.test" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, code: "mail_send_failed" });
  });
});
