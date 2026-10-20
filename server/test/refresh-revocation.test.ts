/**
 * STAGE F12 (ISSUE-121) — VULN-002: refresh tokens must die with the session.
 *
 * The access token is a stateless JWT and refresh_tokens is its own table, so
 * deleting user_sessions rows alone leaves a live way back in. Three ordered
 * invariants:
 *
 *   1. POST /v5/auth/password/reset revokes every refresh token of the user.
 *   2. POST /v5/admin/users/:id/disable (withhold) revokes every refresh token
 *      of the user — in the same transaction as the session wipe.
 *   3. POST /v5/auth/refresh rejects a disabled user's token with the SAME
 *      generic envelope as an unknown/expired/revoked one (no oracle).
 *
 * Own file on purpose: the per-instance auth rate limiter (30/hour per IP) is
 * shared by register/login/forgot/reset inside one app instance, and this file
 * spends 8 of that budget on three self-sufficient fixtures. The mailer is
 * mocked exactly like auth-email.test.ts so no SMTP is attempted and the reset
 * token is readable from the captured body.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { drainTestPhaseDirs, testTmpDir } from "./helpers/tmp-dirs.js";

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

/** Deterministic test secret (32+ chars) — never a production value. */
const TEST_JWT_SECRET = "refresh-revocation-test-0123456789abcdef0123456789abcdef";
const OPERATOR = "refresh-revocation-operator-0123456789abcdef";
const DASHBOARD = "https://dashboard.example.test";
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;
let seq = 0;

/** Unique email per fixture — no two tests can contend for one account. */
function nextEmail(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}@example.test`;
}

function makeApp(): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-refresh-revocation-test-"), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: OPERATOR,
      DASHBOARD_BASE_URL: DASHBOARD,
    },
  });
}

/** Seeds a configured SMTP row so /v5/auth/password/forgot actually issues a token. */
function seedMailConfig(): void {
  app.db
    .prepare(
      "INSERT INTO mail_config (id, host, port, username, password_encrypted, from_address, updated_at) " +
        "VALUES (1, 'smtp.example.test', 465, 'u@example.test', 'v1:aaaa:bbbb:cccc', 'f@example.test', unixepoch()) " +
        "ON CONFLICT(id) DO UPDATE SET host = excluded.host, port = excluded.port, " +
        "username = excluded.username, password_encrypted = excluded.password_encrypted, " +
        "from_address = excluded.from_address, updated_at = excluded.updated_at",
    )
    .run();
}

/** Extracts the raw token from an emailed link body (…/#/reset/<token>). */
function tokenFromLink(body: string): string {
  const match = /#\/(?:verify|reset)\/([A-Za-z0-9_-]+)/.exec(body);
  if (!match) throw new Error(`no token link in email body: ${body}`);
  return match[1];
}

interface Fixture {
  userId: string;
  email: string;
  refreshToken: string;
}

/** Registers a new user and logs in, returning the row id + a live refresh token. */
async function freshUser(prefix: string): Promise<Fixture> {
  const email = nextEmail(prefix);
  const reg = await app.inject({ method: "POST", url: "/v5/auth/register", payload: { email, password: PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const login = await app.inject({ method: "POST", url: "/v5/auth/login", payload: { email, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const row = app.db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
  if (!row) throw new Error("registered user row missing");
  return { userId: row.id, email, refreshToken: login.json().refreshToken as string };
}

/** Every refresh_tokens row for a user, oldest first. */
function refreshRows(userId: string): Array<{ revoked_at: number | null }> {
  return app.db
    .prepare("SELECT revoked_at FROM refresh_tokens WHERE user_id = ? ORDER BY created_at, rowid")
    .all(userId) as Array<{ revoked_at: number | null }>;
}

async function refresh(refreshToken: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: "POST", url: "/v5/auth/refresh", payload: { refreshToken } });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function op(method: "POST", url: string, payload?: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${OPERATOR}` },
    ...(payload === undefined ? {} : { payload }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  app = makeApp();
  seedMailConfig();
});

afterAll(async () => {
  await app.close();
  // The shared tracker drains collection-phase dirs from ITS OWN afterAll,
  // which vitest is free to run before this file's — while the SQLite handle
  // is still open, so its -wal file can be rewritten mid-removal and leave the
  // directory behind, which global-setup.ts then reports as an ISSUE-50 leak
  // (observed under load: 819/819 green, exit 1). Draining again AFTER the
  // connection is closed closes that window; the helper splices drained dirs
  // out, so a second pass is a no-op.
  drainTestPhaseDirs();
});

describe("VULN-002: password reset kills refresh tokens", () => {
  it("revokes every refresh token of the user while leaving later logins able to refresh", async () => {
    const user = await freshUser("reset-revoke");

    // Control: the fixture's token works BEFORE the reset, so the 401 after it
    // can only be the revocation (a dead fixture would make this test pass
    // vacuously).
    const live = await refresh(user.refreshToken);
    expect(live.statusCode).toBe(200);
    const survivor = live.body.refreshToken as string;

    sent.length = 0;
    const forgot = await app.inject({
      method: "POST",
      url: "/v5/auth/password/forgot",
      payload: { email: user.email },
    });
    expect(forgot.statusCode).toBe(200);
    const resetMail = sent.find((m) => m.to === user.email && m.subject.includes("Reset your dP Relay password"));
    if (!resetMail) throw new Error("reset email was not captured");
    const token = tokenFromLink(resetMail.text);

    const reset = await app.inject({
      method: "POST",
      url: "/v5/auth/password/reset",
      payload: { token, password: "fresh-password-123" },
    });
    expect(reset.statusCode).toBe(200);

    // The row state: every pre-reset token is revoked, not merely unlisted.
    const rows = refreshRows(user.userId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);

    // The behavior: the rotation survivor is dead after the reset.
    const after = await refresh(survivor);
    expect(after.statusCode).toBe(401);
    expect(after.body).toMatchObject({ ok: false, code: "invalid_refresh_token" });

    // Scope control: the account is not broken — a login AFTER the reset mints
    // a refresh token that still works.
    const relogin = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      payload: { email: user.email, password: "fresh-password-123" },
    });
    expect(relogin.statusCode).toBe(200);
    const postReset = await refresh(relogin.json().refreshToken as string);
    expect(postReset.statusCode).toBe(200);
  });
});

describe("VULN-002: admin withhold kills refresh tokens", () => {
  it("revokes every refresh token in the withhold transaction and rejects the old token", async () => {
    const user = await freshUser("withhold-revoke");

    const disable = await op("POST", `/v5/admin/users/${user.userId}/disable`, {
      reason: "chargeback investigation",
    });
    expect(disable.statusCode).toBe(200);

    // Row state: revoked by the transaction, not by the later refresh attempt.
    const rows = refreshRows(user.userId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);

    // Behavior: the token issued before the withhold no longer refreshes.
    const after = await refresh(user.refreshToken);
    expect(after.statusCode).toBe(401);
    expect(after.body).toMatchObject({ ok: false, code: "invalid_refresh_token" });
  });
});

describe("VULN-002: /v5/auth/refresh rejects disabled users generically", () => {
  it("returns the same envelope as a revoked token, leaking no account state", async () => {
    const user = await freshUser("disabled-refresh");

    // Disable the row DIRECTLY: this isolates the disabled check in the refresh
    // route from the revocation the withhold transaction performs, so a passing
    // assertion proves the check exists on its own.
    app.db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(user.userId);

    const after = await refresh(user.refreshToken);
    expect(after.statusCode).toBe(401);
    expect(after.body).toEqual({
      ok: false,
      error: "Invalid, expired, or revoked refresh token",
      code: "invalid_refresh_token",
    });
    // No oracle: the answer must be indistinguishable from an unknown token and
    // must not name the account or its state.
    expect(JSON.stringify(after.body)).not.toMatch(/disabled|withheld|verified|@example/i);
  });
});
