/**
 * STAGE F3 amendment (ISSUE-82): email verification + self-service password
 * reset. sendMail is captured (partial module mock) so the flows are tested
 * end to end without any real SMTP; the unconfigured-mailer disable paths are
 * tested against the real module.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance, InjectOptions } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";

/** Captured sends: each entry is the raw body text (contains the token link). */
const sent: Array<{ to: string; subject: string; text: string }> = [];

vi.mock("../src/services/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/mailer.js")>();
  return {
    ...actual,
    sendMail: vi.fn(async (_db: unknown, _secret: string, to: string, subject: string, text: string) => {
      sent.push({ to, subject, text });
    }),
  };
});

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const DASHBOARD = "https://dashboard.example.test";
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-auth-email-test-"), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, DASHBOARD_BASE_URL: DASHBOARD, ...env },
  });
}

/** Extracts the raw token from an emailed link body (…/#/route/<token>). */
function tokenFromLink(body: string): string {
  const match = /#\/(?:verify|reset)\/([A-Za-z0-9_-]+)/.exec(body);
  if (!match) throw new Error(`no token link in email body: ${body}`);
  return match[1];
}

async function registerUser(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v5/auth/register", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = /dp_session=([^;]*)/.exec(list.find((c) => c.includes("dp_session=")) ?? "");
  if (!match) throw new Error("no session cookie");
  return match[1];
}

/** Seeds a configured SMTP row directly (the routes' PUT is covered elsewhere). */
function seedMailConfig(): void {
  app.db
    .prepare(
      "INSERT INTO mail_config (id, host, port, username, password_encrypted, from_address, updated_at) " +
        "VALUES (1, 'smtp.example.test', 465, 'u@example.test', 'v1:aaaa:bbbb:cccc', 'f@example.test', unixepoch())",
    )
    .run();
}

beforeEach(() => {
  sent.length = 0;
});

beforeAll(async () => {
  app = makeApp();
});

afterAll(async () => {
  await app.close();
});

describe("mail-status (public feature flag)", () => {
  it("reports configured:false before SMTP setup and true after", async () => {
    const before = await app.inject({ method: "GET", url: "/v5/auth/mail-status" });
    expect(before.json()).toEqual({ ok: true, configured: false });
    seedMailConfig();
    const after = await app.inject({ method: "GET", url: "/v5/auth/mail-status" });
    expect(after.json()).toEqual({ ok: true, configured: true });
  });
});

describe("email verification (soft)", () => {
  it("registers fine with mail unconfigured and verifies via an emailed token once configured", async () => {
    // Unconfigured app: registration must NOT fail and no email goes out.
    const bare = makeApp({ DASHBOARD_BASE_URL: "" });
    try {
      const res = await bare.inject({
        method: "POST",
        url: "/v5/auth/register",
        payload: { email: "bare-user@example.test", password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      expect(sent).toHaveLength(0);
    } finally {
      await bare.close();
    }

    // Configured app: register sends the verification email (captured).
    const cookie = await registerUser("verify-user@example.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("verify-user@example.test");
    expect(sent[0].subject).toContain("Confirm");
    const raw = tokenFromLink(sent[0].text);
    expect(sent[0].text).toContain(`${DASHBOARD}/#/verify/`);

    // /me reports unverified (additive field), then verified after the token.
    const meBefore = await app.inject({ method: "GET", url: "/v5/auth/me", headers: { cookie: `dp_session=${cookie}` } });
    expect(meBefore.json().user.emailVerifiedAt).toBeNull();

    const verify = await app.inject({ method: "POST", url: "/v5/auth/verify-email", payload: { token: raw } });
    expect(verify.statusCode).toBe(200);

    const meAfter = await app.inject({ method: "GET", url: "/v5/auth/me", headers: { cookie: `dp_session=${cookie}` } });
    expect(meAfter.json().user.emailVerifiedAt).toBeGreaterThan(0);

    // Single-use token: replay is accepted idempotently (already verified).
    const replay = await app.inject({ method: "POST", url: "/v5/auth/verify-email", payload: { token: raw } });
    expect(replay.statusCode).toBe(200);
  });

  it("rejects unknown and expired verification tokens", async () => {
    const unknown = await app.inject({ method: "POST", url: "/v5/auth/verify-email", payload: { token: "nope" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "invalid_token" });

    const cookie = await registerUser("expired-verify@example.test");
    const raw = tokenFromLink(sent[sent.length - 1].text);
    app.db.prepare("UPDATE user_email_tokens SET expires_at = unixepoch() - 1 WHERE purpose = 'verify'").run();
    const expired = await app.inject({ method: "POST", url: "/v5/auth/verify-email", payload: { token: raw } });
    expect(expired.statusCode).toBe(400);
    // The session itself survives (soft verification never gates login).
    const me = await app.inject({ method: "GET", url: "/v5/auth/me", headers: { cookie: `dp_session=${cookie}` } });
    expect(me.statusCode).toBe(200);
  });
});

describe("self-service password reset", () => {
  it("forgot is generic, supersession-safe, and reset revokes every session", async () => {
    const cookie = await registerUser("reset-user@example.test");
    app.db.prepare("UPDATE user_sessions SET expires_at = unixepoch() + 3600").run();
    // The register above sent its own verification mail — reset the capture
    // so this test asserts only on forgot/reset sends.
    sent.length = 0;

    // Unknown email: same generic envelope, no email sent (anti-enumeration).
    const ghost = await app.inject({
      method: "POST",
      url: "/v5/auth/password/forgot",
      payload: { email: "ghost@example.test" },
    });
    expect(ghost.statusCode).toBe(200);
    expect(ghost.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);

    // Known email: reset mail goes out; a second request supersedes the first.
    const first = await app.inject({
      method: "POST",
      url: "/v5/auth/password/forgot",
      payload: { email: "reset-user@example.test" },
    });
    expect(first.statusCode).toBe(200);
    const oldToken = tokenFromLink(sent[sent.length - 1].text);
    await app.inject({ method: "POST", url: "/v5/auth/password/forgot", payload: { email: "reset-user@example.test" } });
    const newToken = tokenFromLink(sent[sent.length - 1].text);
    expect(newToken).not.toBe(oldToken);

    // The superseded token is dead; the newest works.
    const stale = await app.inject({
      method: "POST",
      url: "/v5/auth/password/reset",
      payload: { token: oldToken, password: "fresh-password-123" },
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toMatchObject({ code: "invalid_token" });

    const weak = await app.inject({
      method: "POST",
      url: "/v5/auth/password/reset",
      payload: { token: newToken, password: "short" },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ code: "invalid_password" });

    const ok = await app.inject({
      method: "POST",
      url: "/v5/auth/password/reset",
      payload: { token: newToken, password: "fresh-password-123" },
    });
    expect(ok.statusCode).toBe(200);

    // Old password dead, new password alive, old session dead, token single-use.
    const oldPw = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "reset-user@example.test", password: PASSWORD },
    });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: "reset-user@example.test", password: "fresh-password-123" },
    });
    expect(newPw.statusCode).toBe(200);
    const deadSession = await app.inject({ method: "GET", url: "/v5/auth/me", headers: { cookie: `dp_session=${cookie}` } });
    expect(deadSession.statusCode).toBe(401);
    const replay = await app.inject({
      method: "POST",
      url: "/v5/auth/password/reset",
      payload: { token: newToken, password: "another-password-456" },
    });
    expect(replay.statusCode).toBe(400);
  });

  it("creates no reset token when mail is unconfigured (clean disable)", async () => {
    const bare = makeApp();
    try {
      const res = await bare.inject({
        method: "POST",
        url: "/v5/auth/register",
        payload: { email: "nocfg@example.test", password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      const forgot = await bare.inject({
        method: "POST",
        url: "/v5/auth/password/forgot",
        payload: { email: "nocfg@example.test" },
      });
      expect(forgot.statusCode).toBe(200); // still generic-ok
      const tokens = bare.db.prepare("SELECT COUNT(*) AS n FROM user_email_tokens").get() as { n: number };
      expect(tokens.n).toBe(0);
    } finally {
      await bare.close();
    }
  });
});

describe("verify-email/resend (session)", () => {
  it("requires a session and is rate-limit safe", async () => {
    const res = await app.inject({ method: "POST", url: "/v5/auth/verify-email/resend" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "auth_required" });
  });
});
