/**
 * /health/alerts regression tests.
 *
 * `alert_sink_degraded` is a log line. A log line pages nobody, which is the
 * whole problem: the mechanism whose job is to announce that alerting is broken
 * has no channel of its own. This endpoint exists so an external monitor can
 * poll reachability instead of scraping logs.
 *
 * The load-bearing case is the separation from /health. If these were one
 * endpoint, a dead Telegram sink would make the platform restart a perfectly
 * healthy API — turning an alerting outage into a service outage. That is pinned
 * explicitly below, because it is the most tempting "simplification" available.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import {
  dispatchAlert,
  resetAlertSinkHealth,
  type AlertSinkStatus,
  type WatchdogAlert,
} from "../src/jobs.js";
import { loadConfig } from "../src/config.js";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";

const ALERT: WatchdogAlert = {
  type: "device_heartbeat_stale",
  deviceIds: ["dev-1"],
  phones: [null],
  count: 1,
  threshold_sec: 900,
  detected_at: "2026-01-01T00:00:00.000Z",
};

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(testTmpDir("dprelay-sinkhealth-"), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET, ...env } });
}

const cfg = (env: Record<string, string>) => loadConfig({ JWT_SECRET: TEST_JWT_SECRET, ...env });

const noopLog = { warn() {}, info() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

/** Stubs fetch so every dispatch gets `status`, without touching the network. */
function stubFetch(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) }) as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Sink health is process-lifetime by design, so it must be reset between
  // tests or one test's failures silently degrade the next test's endpoint.
  resetAlertSinkHealth();
});

describe("GET /health/alerts", () => {
  it("reports degraded when NO sink is configured, because log-only is not healthy", async () => {
    const app = makeApp();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/alerts" });

    expect(res.statusCode).toBe(503);
    const body = res.json() as AlertSinkStatus;
    expect(body.degraded).toBe(true);
    expect(body.reason).toContain("no alert sink is configured");
    expect(body.sinks.map((s) => s.sink).sort()).toEqual(["telegram", "webhook"]);
    expect(body.sinks.every((s) => s.configured === false)).toBe(true);
    await app.close();
  });

  it("reports healthy once a configured sink is delivering", async () => {
    stubFetch(200);
    const app = makeApp({ TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN", TELEGRAM_CHAT_ID: "-100200300" });
    await app.ready();

    await dispatchAlert(
      noopLog,
      cfg({ TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN", TELEGRAM_CHAT_ID: "-100200300" }),
      ALERT,
    );
    const res = await app.inject({ method: "GET", url: "/health/alerts" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AlertSinkStatus;
    expect(body.degraded).toBe(false);
    expect(body.reason).toContain("ok");
    const telegram = body.sinks.find((s) => s.sink === "telegram");
    expect(telegram?.configured).toBe(true);
    expect(telegram?.consecutiveFailures).toBe(0);
    await app.close();
  });

  it("reports degraded and names the sink after it crosses the failure threshold", async () => {
    stubFetch(500);
    const env = {
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "2",
    };
    const app = makeApp(env);
    await app.ready();
    const config = cfg(env);

    // One failure is below the threshold and must NOT raise the endpoint: the
    // whole point of the threshold is not paging on a single blip.
    await dispatchAlert(noopLog, config, ALERT);
    expect((await app.inject({ method: "GET", url: "/health/alerts" })).statusCode).toBe(200);

    await dispatchAlert(noopLog, config, ALERT);
    const res = await app.inject({ method: "GET", url: "/health/alerts" });

    expect(res.statusCode).toBe(503);
    const body = res.json() as AlertSinkStatus;
    expect(body.degraded).toBe(true);
    expect(body.reason).toContain("'telegram'");
    expect(body.reason).toContain("failed 2 times consecutively");
    const telegram = body.sinks.find((s) => s.sink === "telegram");
    expect(telegram?.degradedSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await app.close();
  });

  it("clears degraded once the sink delivers again", async () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "1",
    };
    const app = makeApp(env);
    await app.ready();
    const config = cfg(env);

    stubFetch(500);
    await dispatchAlert(noopLog, config, ALERT);
    expect((await app.inject({ method: "GET", url: "/health/alerts" })).statusCode).toBe(503);

    stubFetch(200);
    await dispatchAlert(noopLog, config, ALERT);
    const res = await app.inject({ method: "GET", url: "/health/alerts" });

    expect(res.statusCode).toBe(200);
    expect((res.json() as AlertSinkStatus).degraded).toBe(false);
    await app.close();
  });

  it("keeps /health and /healthz green while alerting is degraded (no self-DoS)", async () => {
    stubFetch(500);
    const app = makeApp({
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "1",
    });
    await app.ready();
    await dispatchAlert(
      noopLog,
      cfg({
        TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
        TELEGRAM_CHAT_ID: "-100200300",
        ALERT_SINK_FAILURE_THRESHOLD: "1",
      }),
      ALERT,
    );

    // A platform health check pointed at a 503 endpoint would restart the API
    // because Telegram is down. That converts an alerting outage into a service
    // outage, so these two must be unaffected.
    expect((await app.inject({ method: "GET", url: "/health/alerts" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });

  it("never leaks the failure detail, only counters", async () => {
    const secretishUrl = "https://receiver.example.com/hooks/whsec-SUPERSECRETVALUE";
    stubFetch(500);
    const env = {
      ALERT_WEBHOOK_URL: secretishUrl,
      ALERT_WEBHOOK_SECRET: "whsec-SUPERSECRETVALUE",
      ALERT_SINK_FAILURE_THRESHOLD: "1",
    };
    const app = makeApp(env);
    await app.ready();
    await dispatchAlert(noopLog, cfg(env), ALERT);

    const res = await app.inject({ method: "GET", url: "/health/alerts" });

    expect(res.statusCode).toBe(503);
    // The endpoint is unauthenticated so a monitor can poll it, so the payload
    // must not carry the URL or the secret that lastError would otherwise hold.
    expect(res.body).not.toContain("SUPERSECRETVALUE");
    expect(res.body).not.toContain("receiver.example.com");
    expect(res.body).not.toContain("lastError");
    await app.close();
  });
});
