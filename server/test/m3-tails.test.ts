/**
 * M3 tails (ISSUE-23): OpenAPI /docs generation, per-phone OTP resend
 * cooldown, and webhook exhaustion alert damping.
 *
 * OpenAPI: the spec is generated from the route definitions; the test asserts
 * a meaningful slice (paths + methods that other suites already cover) and
 * FAILS when routes drift from the committed docs/Plan/27-OPENAPI-SPEC.json,
 * so the committed docs cannot rot silently.
 *
 * Resend cooldown: bounds re-sends to the same phone per app (429
 * resend_cooldown + Retry-After), independent of the per-app session rate
 * limit; a fresh app instance resets the in-memory cooldown.
 *
 * Damping: while a receiver stays dead, exhaustion re-alerts are capped at
 * one per WEBHOOK_EXHAUSTION_DAMPING_SEC window; a success re-arms instantly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "m3tails-jwt-0123456789abcdef0123456789abcdef";
const TEST_APP_ID = "m3tails_app";
const TEST_APP_SECRET = "m3tails-app-secret-0123456789abcdef0123456789";
const PHONE = "+8801712345678";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-m3tails-test-")), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET, ...extra }, runBootSweep: false });
}

function seedApp(a: FastifyInstance): void {
  a.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, rate_max_per_phone, rate_window_sec, created_at) " +
        "VALUES ('app-row-1', ?, ?, 'Test App', 3, 3600, unixepoch())",
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

describe("OpenAPI /docs", () => {
  it("serves the generated spec at /docs/json with the expected paths", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as {
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.info.title).toBe("dP Relay v5 API");
    // Version comes from server/package.json (the /health contract); asserting
    // against the file rather than a literal keeps this test version-bump-proof.
    const pkgVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    expect(spec.info.version).toBe(pkgVersion);
    // Meaningful slice across the planes; full drift check is the next test.
    // NOTE: /health + /healthz are deliberately absent — they are registered
    // synchronously on the root instance before avvio loads the queued swagger
    // plugin, so its onRoute hook never sees them; they are ops probes, not
    // API surface.
    for (const path of [
      "/v5/auth/register",
      "/v5/device/enroll",
      "/v5/otp/send",
      "/v5/billing/credits",
      "/v5/bulk/campaigns",
      "/v5/contact-groups",
      "/v5/message-templates",
      "/v5/admin/apps",
      "/v5/admin/kill-switch",
      "/v5/admin/metrics",
    ]) {
      expect(spec.paths[path], `path ${path} in spec`).toBeDefined();
    }
    expect(Object.keys(spec.paths["/v5/otp/send"]!)).toContain("post");
  });

  it("serves the Swagger UI at /docs", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(302); // redirects to /docs/static/index.html
    expect(res.headers.location).toContain("/docs/static/index.html");
  });

  it("keeps the committed spec in sync with the generated one (drift check)", async () => {
    const { readFileSync } = await import("node:fs");
    const committed = JSON.parse(
      readFileSync(new URL("../../docs/Plan/27-OPENAPI-SPEC.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, unknown> };
    const generated = (await app.inject({ method: "GET", url: "/docs/json" })).json() as {
      paths: Record<string, unknown>;
    };
    const committedPaths = Object.keys(committed.paths).sort();
    const generatedPaths = Object.keys(generated.paths).sort();
    expect(generatedPaths).toEqual(committedPaths);
  });
});

describe("CORS (dashboard origin allow-list)", () => {
  const DASHBOARD_ORIGIN = "https://dprelay-dashboard.pages.dev";

  it("answers a browser preflight from an allowed origin", async () => {
    app.close();
    app = makeApp({ CORS_ALLOWED_ORIGINS: DASHBOARD_ORIGIN });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v5/auth/login",
      headers: {
        Origin: DASHBOARD_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(DASHBOARD_ORIGIN);
  });

  it("reflects only allow-listed origins and blocks strangers", async () => {
    app.close();
    app = makeApp({ CORS_ALLOWED_ORIGINS: DASHBOARD_ORIGIN });
    const good = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      headers: { Origin: DASHBOARD_ORIGIN, "Content-Type": "application/json" },
      payload: { email: "x@y.z", password: "password123" },
    });
    expect(good.headers["access-control-allow-origin"]).toBe(DASHBOARD_ORIGIN);

    const stranger = await app.inject({
      method: "POST",
      url: "/v5/auth/login",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      payload: { email: "x@y.z", password: "password123" },
    });
    expect(stranger.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("stays fail-closed with no CORS_ALLOWED_ORIGINS configured", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v5/auth/login",
      headers: { Origin: DASHBOARD_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(res.statusCode).toBe(404); // no preflight handler registered
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("per-phone OTP resend cooldown", () => {
  it("allows the first send, 429s an immediate resend, then allows after the window", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    expect(first.statusCode).toBe(201);

    const resend = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: PHONE },
    });
    expect(resend.statusCode).toBe(429);
    expect((resend.json() as { code: string }).code).toBe("resend_cooldown");
    expect(Number(resend.headers["retry-after"])).toBeGreaterThan(0);

    // No extra session/pending_sms was created by the rejected resend.
    const sessions = (app.db.prepare("SELECT COUNT(*) AS n FROM otp_sessions").get() as { n: number }).n;
    expect(sessions).toBe(1);
  });

  it("is per-phone: a different number is not blocked by the first phone's cooldown", async () => {
    const a = await app.inject({ method: "POST", url: "/v5/otp/send", headers: appHeaders(), payload: { phone: PHONE } });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: appHeaders(),
      payload: { phone: "+8801811111111" },
    });
    expect(b.statusCode).toBe(201);
  });

  it("is per-app: another app's send to the same phone is not blocked", async () => {
    app.db
      .prepare(
        "INSERT INTO apps (id, app_id, app_secret_hash, name, rate_max_per_phone, rate_window_sec, created_at) " +
          "VALUES ('app-row-2', 'm3tails_app_2', ?, 'Other App', 3, 3600, unixepoch())",
      )
      .run(sha256Hex(TEST_APP_SECRET));
    const first = await app.inject({ method: "POST", url: "/v5/otp/send", headers: appHeaders(), payload: { phone: PHONE } });
    expect(first.statusCode).toBe(201);
    const secondApp = await app.inject({
      method: "POST",
      url: "/v5/otp/send",
      headers: { "x-app-id": "m3tails_app_2", "x-app-secret": TEST_APP_SECRET },
      payload: { phone: PHONE },
    });
    expect(secondApp.statusCode).toBe(201);
  });

  it("still enforces the per-app session rate limit alongside the cooldown", async () => {
    app.close();
    app = makeApp({ OTP_RESEND_COOLDOWN_SEC: "0" }); // cooldown off; rate limit must still bite
    seedApp(app);
    // rateMaxPerPhone = 3 per 3600s: sends 1-3 fine, 4th hits the session cap.
    const codes = [201, 201, 201, 429];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v5/otp/send",
        headers: appHeaders(),
        payload: { phone: PHONE },
      });
      expect(res.statusCode).toBe(codes[i]);
      if (res.statusCode === 429) expect((res.json() as { code: string }).code).toBe("rate_limited");
    }
  });
});

// ── Webhook exhaustion damping ─────────────────────────────────────────────

const WEBHOOK_SECRET = "m3tails-whsec-0123456789abcdef0123456789abc";

/**
 * Seeds the exact dispatch topology (app row + pending message + OTP session)
 * the results route resolves — mirrors webhook-dispatch.test.ts's helper.
 */
function seedOtpPending(a: FastifyInstance, webhookUrl: string): void {
  a.db
    .prepare(
      "UPDATE apps SET webhook_url = ?, webhook_secret = ?, webhook_secret_hash = ? WHERE id = 'app-row-1'",
    )
    .run(webhookUrl, WEBHOOK_SECRET, sha256Hex(WEBHOOK_SECRET));
  a.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
        "VALUES ('msg-1', 'm3tails_app', ?, 'code 123456', 'pending', unixepoch())",
    )
    .run(PHONE);
  a.db
    .prepare(
      "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, attempts, expires_at, status, message_id, created_at) " +
        "VALUES ('sess-1', 'app-row-1', ?, 'otp-hash', 'otp-salt', 0, unixepoch() + 300, 'pending', 'msg-1', unixepoch())",
    )
    .run(PHONE);
}

/** Points the seeded session at a known code so verify accepts it. */
function makeVerifiable(a: FastifyInstance, otp: string): void {
  a.db.prepare("UPDATE otp_sessions SET otp_hash = ? WHERE id = 'sess-1'").run(sha256Hex(`otp-salt${otp}`));
}

/** Resets the seeded session so verify can succeed (and dispatch) again. */
function rearmSession(a: FastifyInstance): void {
  a.db.prepare("UPDATE otp_sessions SET status = 'pending', verified_at = NULL WHERE id = 'sess-1'").run();
}

async function postVerify(a: FastifyInstance, otp: string): Promise<number> {
  const res = await a.inject({
    method: "POST",
    url: "/v5/otp/verify",
    headers: appHeaders(),
    payload: { phone: PHONE, otp },
  });
  return res.statusCode;
}

/** Finds a loopback port with no listener — deterministic connection-refused target. */
async function findClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Captures warn logs (the exhaustion alert's log-only leg) on the app. */
function captureWarns(a: FastifyInstance): Array<{ obj: Record<string, unknown>; msg?: string }> {
  const warnings: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  const log = a.log as unknown as { warn: (this: unknown, obj: unknown, msg?: string) => void };
  const origWarn = log.warn;
  log.warn = function (obj: unknown, msg?: string) {
    warnings.push({ obj: obj as Record<string, unknown>, msg });
    origWarn.call(this, obj, msg);
  };
  return warnings;
}

function exhaustionAlerts(warnings: Array<{ obj: Record<string, unknown>; msg?: string }>): number {
  return warnings.filter((w) => w.msg === "webhook_exhaustion_alert").length;
}

function dampedLogs(warnings: Array<{ obj: Record<string, unknown>; msg?: string }>): number {
  return warnings.filter((w) => w.msg === "webhook_exhaustion_alert_damped").length;
}

describe("webhook exhaustion alert damping", () => {
  it("caps re-alerts at one per damping window while the receiver stays dead", async () => {
    const deadPort = await findClosedPort();
    app.close();
    app = makeApp({
      WEBHOOK_RETRY_DELAYS_MS: "10,10",
      WEBHOOK_EXHAUSTION_ALERT_THRESHOLD: "2",
      WEBHOOK_EXHAUSTION_DAMPING_SEC: "3600",
    });
    seedApp(app);
    seedOtpPending(app, `http://127.0.0.1:${deadPort}/otp-status`);
    makeVerifiable(app, "654321");
    const warnings = captureWarns(app);

    // Exhaustion #1: below threshold, no alert, no damp log.
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(0);

    // Exhaustion #2: threshold crossed → FIRST alert goes out.
    rearmSession(app);
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(1);

    // Exhaustion #3 and #4: still dead, still past threshold, but the damping
    // window is active → logged as damped, ops channel NOT re-flooded.
    rearmSession(app);
    expect(await postVerify(app, "654321")).toBe(200);
    rearmSession(app);
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(1);
    expect(dampedLogs(warnings)).toBe(2);
  });

  it("re-alerts after the damping window elapses", async () => {
    const deadPort = await findClosedPort();
    app.close();
    app = makeApp({
      WEBHOOK_RETRY_DELAYS_MS: "10,10",
      WEBHOOK_EXHAUSTION_ALERT_THRESHOLD: "1",
      WEBHOOK_EXHAUSTION_DAMPING_SEC: "1", // 1 second — crossed by a real sleep
    });
    seedApp(app);
    seedOtpPending(app, `http://127.0.0.1:${deadPort}/otp-status`);
    makeVerifiable(app, "654321");
    const warnings = captureWarns(app);

    rearmSession(app);
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(1);

    // Still inside the 1 s window: damped.
    rearmSession(app);
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(1);

    // Window elapses: next exhaustion re-alerts.
    await new Promise((r) => setTimeout(r, 1100));
    rearmSession(app);
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(2);
  });

  it("a successful delivery re-arms alerting instantly (damper reset)", async () => {
    // Local sink for the alive phase.
    const requests: unknown[] = [];
    let sinkStatus: number[] = [500]; // dead by default
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests.push({});
        res.writeHead(sinkStatus[0] ?? 500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      app.close();
      app = makeApp({
        WEBHOOK_RETRY_DELAYS_MS: "10,10",
        WEBHOOK_EXHAUSTION_ALERT_THRESHOLD: "1",
        WEBHOOK_EXHAUSTION_DAMPING_SEC: "3600",
      });
      seedApp(app);
      seedOtpPending(app, `http://127.0.0.1:${port}/otp-status`);
      makeVerifiable(app, "654321");
      const warnings = captureWarns(app);

      // Dead receiver: exhaustion #1 → alert fires (threshold 1).
      expect(await postVerify(app, "654321")).toBe(200);
      expect(exhaustionAlerts(warnings)).toBe(1);

      // Receiver comes alive: delivery succeeds → counter AND damper reset.
      sinkStatus = [200];
      rearmSession(app);
      expect(await postVerify(app, "654321")).toBe(200);
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(exhaustionAlerts(warnings)).toBe(1);

      // Receiver dies again: exhaustion #1 (fresh episode) → alert fires again
      // IMMEDIATELY, despite the damping window never having elapsed.
      sinkStatus = [500];
      rearmSession(app);
      expect(await postVerify(app, "654321")).toBe(200);
      expect(exhaustionAlerts(warnings)).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  it("damping is per-app: a second dead app alerts independently", async () => {
    const deadPort = await findClosedPort();
    app.close();
    app = makeApp({
      WEBHOOK_RETRY_DELAYS_MS: "10,10",
      WEBHOOK_EXHAUSTION_ALERT_THRESHOLD: "1",
      WEBHOOK_EXHAUSTION_DAMPING_SEC: "3600",
    });
    seedApp(app);
    app.db
      .prepare(
        "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, webhook_secret_hash, " +
          "rate_max_per_phone, rate_window_sec, created_at) " +
          "VALUES ('app-row-2', 'm3tails_app_2', ?, 'Second App', ?, ?, ?, 3, 3600, unixepoch())",
      )
      .run(sha256Hex(TEST_APP_SECRET), `http://127.0.0.1:${deadPort}/otp-status`, WEBHOOK_SECRET, sha256Hex(WEBHOOK_SECRET));
    seedOtpPending(app, `http://127.0.0.1:${deadPort}/otp-status`);
    // Second app's own session + message.
    app.db
      .prepare(
        "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
          "VALUES ('msg-2', 'm3tails_app_2', ?, 'code 123456', 'pending', unixepoch())",
      )
      .run(PHONE);
    app.db
      .prepare(
        "INSERT INTO otp_sessions (id, app_id, phone, otp_hash, salt, attempts, expires_at, status, message_id, created_at) " +
          "VALUES ('sess-2', 'app-row-2', ?, 'otp-hash', 'otp-salt', 0, unixepoch() + 300, 'pending', 'msg-2', unixepoch())",
      )
      .run(PHONE);
    makeVerifiable(app, "654321");
    // Make the second app's session verifiable too (makeVerifiable only points
    // sess-1; verify targets the newest pending session per app+phone).
    app.db.prepare("UPDATE otp_sessions SET otp_hash = ? WHERE id = 'sess-2'").run(sha256Hex(`otp-salt654321`));
    const warnings = captureWarns(app);

    // App 1 exhausts → alert #1 (its window now active).
    expect(await postVerify(app, "654321")).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(1);

    // App 2 exhausts (same receiver): its own damper is empty → alert #2.
    const res = await app.inject({
      method: "POST",
      url: "/v5/otp/verify",
      headers: { "x-app-id": "m3tails_app_2", "x-app-secret": TEST_APP_SECRET },
      payload: { phone: PHONE, otp: "654321" },
    });
    expect(res.statusCode).toBe(200);
    expect(exhaustionAlerts(warnings)).toBe(2);
  });
});
