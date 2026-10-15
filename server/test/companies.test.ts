/**
 * ISSUE-113 — customer self-serve DEVICE ENROLLMENT rotation:
 * POST /v5/auth/companies/:id/rotate-device-secret.
 *
 * Lives in its own file (not auth.test.ts) on purpose: the customer-auth
 * rate limit (AUTH_RATE_MAX_PER_HOUR, 30/hour per IP) is counted per test
 * process, and auth.test.ts already spends ~23 of those on its fixtures —
 * a fresh file gets a clean counter, exactly like f9-tenancy.test.ts.
 *
 * Temp DBs + app.inject: no real network, no shared state between tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance, InjectOptions } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";

let app: FastifyInstance;

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-companies-test-"), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, ...env },
  });
}

afterEach(async () => {
  if (app) await app.close();
});

/** Extracts the dp_session cookie value from a Set-Cookie header list. */
function sessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = list.map((c) => /(?:^|;\s*)dp_session=([^;]*)/.exec(c)).find((m) => m !== null);
  if (!match) throw new Error(`no dp_session cookie in Set-Cookie: ${JSON.stringify(list)}`);
  return match[1];
}

/** Registers a fresh user and returns its session cookie. */
async function registerUser(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/auth/register",
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res.headers["set-cookie"]);
}

function authed(cookie: string, opts: InjectOptions = {}): InjectOptions {
  return { ...opts, headers: { ...(opts.headers ?? {}), cookie: `dp_session=${cookie}` } };
}

interface CompanyApp {
  companyId: string;
  appId: string;
  appSecret: string;
  deviceEnrollmentSecret: string;
}

/** Creates a company via the session route and returns its identifiers. */
async function createCompany(a: FastifyInstance, cookie: string, name: string): Promise<CompanyApp> {
  const res = await a.inject(authed(cookie, { method: "POST", url: "/v5/auth/companies", payload: { name } }));
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    company: { id: string };
    app: { appId: string; appSecret: string; deviceEnrollmentSecret: string };
  };
  return {
    companyId: body.company.id,
    appId: body.app.appId,
    appSecret: body.app.appSecret,
    deviceEnrollmentSecret: body.app.deviceEnrollmentSecret,
  };
}

/** Rotates a company's enrollment secret; returns the raw response body. */
async function rotate(
  a: FastifyInstance,
  cookie: string,
  companyId: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await a.inject(
    authed(cookie, { method: "POST", url: `/v5/auth/companies/${companyId}/rotate-device-secret` }),
  );
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** Enrolls a device with the given Bearer secret; returns status + body. */
async function enroll(
  a: FastifyInstance,
  secret: string,
  label = "gateway phone",
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/device/enroll",
    headers: { authorization: `Bearer ${secret}` },
    payload: { label },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** Stored digest for an app row (apps store hashes, never the raw secret). */
function storedDigest(a: FastifyInstance, appId: string): string {
  const row = a.db
    .prepare("SELECT device_enrollment_secret_hash FROM apps WHERE app_id = ?")
    .get(appId) as { device_enrollment_secret_hash: string };
  return row.device_enrollment_secret_hash;
}

describe("POST /v5/auth/companies/:id/rotate-device-secret (ISSUE-113)", () => {
  it("401s without a session", async () => {
    app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v5/auth/companies/co-nope/rotate-device-secret",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it("404s for a company that does not exist", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "missing-co@example.com");
    const { statusCode, body } = await rotate(app, cookie, "co-does-not-exist");
    expect(statusCode).toBe(404);
    expect(body).toMatchObject({ ok: false, code: "company_not_found" });
  });

  it("404s for ANOTHER user's company (isolation, no secret leaked)", async () => {
    app = makeApp();
    const owner = await registerUser(app, "owner-a@example.com");
    const intruder = await registerUser(app, "intruder-b@example.com");
    const company = await createCompany(app, owner, "Owner shop");

    const before = storedDigest(app, company.appId);
    const { statusCode, body } = await rotate(app, intruder, company.companyId);
    expect(statusCode).toBe(404);
    expect(body).toMatchObject({ ok: false, code: "company_not_found" });
    // Fail-closed: the attempt must not rotate anything or expose a secret.
    expect(body.deviceEnrollmentSecret).toBeUndefined();
    expect(storedDigest(app, company.appId)).toBe(before);
  });

  it("400s on a withheld (disabled) company", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "disabled-co@example.com");
    const company = await createCompany(app, cookie, "Withheld shop");
    const disabled = await app.inject(
      authed(cookie, { method: "POST", url: `/v5/auth/companies/${company.companyId}/disable` }),
    );
    expect(disabled.statusCode).toBe(200);

    const { statusCode, body } = await rotate(app, cookie, company.companyId);
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "company_disabled" });
    expect(body.deviceEnrollmentSecret).toBeUndefined();
  });

  it("400s when the app is revoked", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "revoked-co@example.com");
    const company = await createCompany(app, cookie, "Revoked shop");
    app.db.prepare("UPDATE apps SET revoked_at = unixepoch() WHERE app_id = ?").run(company.appId);

    const { statusCode, body } = await rotate(app, cookie, company.companyId);
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "app_revoked" });
    expect(body.deviceEnrollmentSecret).toBeUndefined();
  });

  it("200s on success: returns the raw secret once and stores only its hash", async () => {
    app = makeApp();
    const cookie = await registerUser(app, "rotate-ok@example.com");
    const company = await createCompany(app, cookie, "Rotate shop");
    const before = storedDigest(app, company.appId);

    const { statusCode, body } = await rotate(app, cookie, company.companyId);
    expect(statusCode).toBe(200);
    const secret = body.deviceEnrollmentSecret;
    expect(body.ok).toBe(true);
    expect(body.companyId).toBe(company.companyId);
    expect(body.appId).toBe(company.appId);
    expect(typeof secret).toBe("string");
    expect(String(secret).length).toBeGreaterThan(0);
    expect(typeof body.rotatedAt).toBe("number");
    expect(body.rotatedAt as number).toBeGreaterThan(0);
    // A new secret, not a re-serve of the old one, and never stored raw.
    expect(secret).not.toBe(company.deviceEnrollmentSecret);
    expect(storedDigest(app, company.appId)).toBe(app.sha256Hex(String(secret)));
    expect(storedDigest(app, company.appId)).not.toBe(before);
  });

  it("re-pairs end to end: the NEW secret enrolls, the OLD one is dead", async () => {
    // Configured with a global enrollment secret so a rejected secret is the
    // unauthorized path (401 invalid_enrollment_secret), not the
    // fail-closed "nothing to enroll against" path (403 enrollment_disabled)
    // a deployment with no global secret returns.
    app = makeApp({ DEVICE_ENROLLMENT_SECRET: "test-global-enrollment-secret-0123456789" });
    const cookie = await registerUser(app, "re-pair@example.com");
    const company = await createCompany(app, cookie, "Re-pair shop");

    // The original secret works before rotation (baseline, not an assumption).
    const beforeEnroll = await enroll(app, company.deviceEnrollmentSecret, "old phone");
    expect(beforeEnroll.statusCode).toBe(201);

    const { statusCode, body } = await rotate(app, cookie, company.companyId);
    expect(statusCode).toBe(200);
    const rotated = String(body.deviceEnrollmentSecret);

    // The replacement phone enrolls with the rotated secret…
    const afterEnroll = await enroll(app, rotated, "new phone");
    expect(afterEnroll.statusCode).toBe(201);
    expect(afterEnroll.body.ok).toBe(true);
    expect(typeof afterEnroll.body.apiKey).toBe("string");

    // …while the previous payload is rejected and mints no device.
    const devicesBefore = (app.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
    const staleEnroll = await enroll(app, company.deviceEnrollmentSecret, "stale phone");
    expect(staleEnroll.statusCode).toBe(401);
    expect(staleEnroll.body).toMatchObject({ ok: false, code: "invalid_enrollment_secret" });
    const devicesAfter = (app.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
    expect(devicesAfter).toBe(devicesBefore);
  });
});
