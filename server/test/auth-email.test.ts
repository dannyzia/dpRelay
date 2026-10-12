/**
 * STAGE F3 amendment (ISSUE-82): email verification + self-service password
 * reset — end-to-end against a REAL SMTP round trip (hub ISSUE-101).
 *
 * Unlike the previous revision of this file, `sendMail` is NOT module-mocked:
 * every send goes through nodemailer to an ephemeral in-process mailbox
 * (./helpers/mailbox.ts) seeded as the `mail_config` row, so these tests
 * exercise the whole transport path — password decryption at send time, the
 * SMTP session itself, and the MIME that actually lands in an inbox — not
 * just the route logic. Tokens are extracted from the received message, which
 * is also a standing regression test for the emailed link format.
 *
 * Shuffle safety (ISSUE-46): every test establishes its own preconditions;
 * the shared app seeds its own mail config, and disable-path tests build
 * separate unconfigured apps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { encryptMailSecret } from "../src/services/mailer.js";
import type { FastifyInstance } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";
import { startMailbox, type Mailbox } from "./helpers/mailbox.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const DASHBOARD = "https://dashboard.example.test";
const PASSWORD = "correct-horse-battery";
const SMTP_USER = "smtp-user@example.test";
const SMTP_PASS = "test-smtp-password-not-a-secret";

let app: FastifyInstance;
let mailbox: Mailbox;

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-auth-email-test-"), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, DASHBOARD_BASE_URL: DASHBOARD, ...env },
  });
}

/**
 * Waits until `count` messages have arrived in the mailbox. Sends are
 * fire-and-forget in the routes (`void sendMail(...)`), so the test must
 * poll for the wire result rather than assume synchronous delivery.
 */
async function waitForMail(count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mailbox.messages.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} message(s), saw ${mailbox.messages.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Decodes a captured message into searchable text: quoted-printable soft
 * line breaks removed (=CRLF) and byte escapes decoded, so a long link split
 * at column 76 is reassembled exactly as the recipient's client would.
 */
function bodyText(raw: string): string {
  const sep = raw.search(/\r?\n\r?\n/);
  const body = sep === -1 ? "" : raw.slice(sep).replace(/^\r?\n\r?\n/, "");
  return body
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
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

/**
 * Seeds a mail_config row pointing at the live mailbox. Idempotent upsert so
 * every test can call it itself instead of relying on ordering (ISSUE-46).
 * The password is encrypted exactly as the admin route would, so the send
 * path's decryption is exercised for real.
 */
function seedMailConfig(): void {
  app.db
    .prepare(
      "INSERT INTO mail_config (id, host, port, username, password_encrypted, from_address, updated_at) " +
        "VALUES (1, '127.0.0.1', ?, ?, ?, 'f@example.test', unixepoch()) " +
        "ON CONFLICT(id) DO UPDATE SET host = excluded.host, port = excluded.port, " +
        "username = excluded.username, password_encrypted = excluded.password_encrypted, " +
        "from_address = excluded.from_address, updated_at = excluded.updated_at",
    )
    .run(mailbox.port, SMTP_USER, encryptMailSecret(SMTP_PASS, TEST_JWT_SECRET));
}

beforeAll(async () => {
  mailbox = await startMailbox();
  app = makeApp();
});

afterAll(async () => {
  await app.close();
  await mailbox.close();
});

beforeEach(() => {
  mailbox.messages.length = 0;
});

describe("mail-status (public feature flag)", () => {
  it("reports configured:false before SMTP setup and true after", async () => {
    // ISSUE-46: force the unconfigured start state — a prior test in this
    // file may already have seeded a config (shuffle-safe ordering).
    app.db.prepare("DELETE FROM mail_config").run();
    const before = await app.inject({ method: "GET", url: "/v5/auth/mail-status" });
    expect(before.json()).toEqual({ ok: true, configured: false });
    seedMailConfig();
    const after = await app.inject({ method: "GET", url: "/v5/auth/mail-status" });
    expect(after.json()).toEqual({ ok: true, configured: true });
  });
});

describe("email verification (soft)", () => {
  it("registers fine with mail unconfigured and verifies via a real emailed token once configured", async () => {
    // ISSUE-46: configured mailer on the shared app — self-sufficient fixture.
    seedMailConfig();

    // Unconfigured app: registration must NOT fail and no email goes out.
    const bare = makeApp({ DASHBOARD_BASE_URL: "" });
    try {
      const res = await bare.inject({
        method: "POST",
        url: "/v5/auth/register",
        payload: { email: "bare-user@example.test", password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      expect(mailbox.messages).toHaveLength(0);
    } finally {
      await bare.close();
    }

    // Configured app: register sends the verification email through SMTP.
    const cookie = await registerUser("verify-user@example.test");
    await waitForMail(1);
    const mail = mailbox.messages[0];
    expect(mail.to).toEqual(["verify-user@example.test"]);
    expect(mail.from).toBe("f@example.test");
    // The wire credentials are the DECRYPTED mail_config values — proof the
    // send path really decrypted the stored secret, not a mock.
    expect(mail.authUser).toBe(SMTP_USER);
    expect(mail.authPass).toBe(SMTP_PASS);
    expect(mail.subject).toContain("Confirm");

    const text = bodyText(mail.raw);
    expect(text).toContain(`${DASHBOARD}/#/verify/`);
    const raw = tokenFromLink(text);

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
    seedMailConfig(); // ISSUE-46: registerUser below must send the verify mail
    const unknown = await app.inject({ method: "POST", url: "/v5/auth/verify-email", payload: { token: "nope" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "invalid_token" });

    const cookie = await registerUser("expired-verify@example.test");
    await waitForMail(1);
    const raw = tokenFromLink(bodyText(mailbox.messages[0].raw));
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
    seedMailConfig(); // ISSUE-46: forgot mails below need a configured mailer
    const cookie = await registerUser("reset-user@example.test");
    app.db.prepare("UPDATE user_sessions SET expires_at = unixepoch() + 3600").run();
    // The register above fired its verification mail asynchronously — WAIT
    // for it to land before clearing, or it arrives after the wipe and gets
    // misidentified as a reset mail below (that poisoning made newToken a
    // verify-purpose token and failed the final reset with 400).
    await waitForMail(1);
    mailbox.messages.length = 0;

    // Unknown email: same generic envelope, no email sent (anti-enumeration).
    const ghost = await app.inject({
      method: "POST",
      url: "/v5/auth/password/forgot",
      payload: { email: "ghost@example.test" },
    });
    expect(ghost.statusCode).toBe(200);
    expect(ghost.json()).toEqual({ ok: true });
    expect(mailbox.messages).toHaveLength(0);

    // Known email: reset mail goes out; a second request supersedes the first.
    const first = await app.inject({
      method: "POST",
      url: "/v5/auth/password/forgot",
      payload: { email: "reset-user@example.test" },
    });
    expect(first.statusCode).toBe(200);
    await waitForMail(1);
    const oldToken = tokenFromLink(bodyText(mailbox.messages[0].raw));
    await app.inject({ method: "POST", url: "/v5/auth/password/forgot", payload: { email: "reset-user@example.test" } });
    await waitForMail(2);
    const newToken = tokenFromLink(bodyText(mailbox.messages[1].raw));
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
