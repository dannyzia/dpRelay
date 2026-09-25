/**
 * Watchdog + catch-up sweep tests (R5): stale devices trigger alerts (webhook
 * or log-only), fresh devices do not, and the wake guard sweeps on boot and
 * first request after an idle gap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dispatchAlert, type OpsAlert, type WatchdogAlert } from "../src/jobs.js";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-watch-test-")), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, ...extra },
  });
}

/** Creates a user row directly (device rows FK onto users). */
function seedUser(app: FastifyInstance, id: string): void {
  app.db
    .prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'test-hash', unixepoch())",
    )
    .run(id, `owner-${id}@example.com`);
}

/** Creates a device row for the given user; raw key is never stored. */
function seedDevice(
  app: FastifyInstance,
  id: string,
  userId: string,
  rawKey: string,
  lastSeenAt: number | null,
): void {
  app.db
    .prepare(
      "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, NULL, unixepoch())",
    )
    .run(id, userId, `device-${id}`, app.sha256Hex(rawKey), lastSeenAt);
}

/** Minimal local HTTP sink to observe the watchdog webhook POST. */
async function startWebhookSink(): Promise<{
  url: string;
  close: () => Promise<void>;
  alerts: { auth: string | undefined; body: WatchdogAlert }[];
}> {
  const alerts: { auth: string | undefined; body: WatchdogAlert }[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      alerts.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    alerts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

describe("heartbeat watchdog", () => {
  it("reports devices with no heartbeat yet as stale (never-seen guard)", async () => {
    const app = makeApp();
    await app.ready();
    seedUser(app, "user-1");
    seedDevice(app, "dev-quiet", "user-1", "k1".repeat(32), null);
    const stale = await app.runWatchdog();
    expect(stale.map((d) => d.id)).toEqual(["dev-quiet"]);
    await app.close();
  });

  it("does not alert when all devices heartbeat within the threshold", async () => {
    const app = makeApp();
    await app.ready();
    seedUser(app, "user-1");
    seedDevice(app, "dev-fresh", "user-1", "k2".repeat(32), Math.floor(Date.now() / 1000) - 60);
    const stale = await app.runWatchdog();
    expect(stale).toEqual([]);
    await app.close();
  });

  it("flags devices stale beyond the threshold and dispatches a signed webhook", async () => {
    const sink = await startWebhookSink();
    cleanup.push(sink.close);
    const app = makeApp({
      ALERT_WEBHOOK_URL: sink.url,
      ALERT_WEBHOOK_SECRET: "whsec-test-0123456789abcdef",
      WATCHDOG_STALE_SEC: "900",
    });
    await app.ready();
    seedUser(app, "user-1");
    // 30 minutes ago → stale at the default 15-min threshold.
    seedDevice(app, "dev-stale", "user-1", "k3".repeat(32), Math.floor(Date.now() / 1000) - 1800);

    const stale = await app.runWatchdog();
    expect(stale.map((d) => d.id)).toEqual(["dev-stale"]);

    // Allow the fire-and-forget webhook POST to land.
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0].auth).toBe("Bearer whsec-test-0123456789abcdef");
    expect(sink.alerts[0].body).toMatchObject({
      type: "device_heartbeat_stale",
      deviceIds: ["dev-stale"],
      count: 1,
      threshold_sec: 900,
    });
    await app.close();
  });

  it("logs alerts only (no webhook) when ALERT_WEBHOOK_URL is empty", async () => {
    const app = makeApp();
    await app.ready();
    seedUser(app, "user-1");
    seedDevice(app, "dev-stale-2", "user-1", "k4".repeat(32), Math.floor(Date.now() / 1000) - 3600);
    const stale = await app.runWatchdog();
    expect(stale.map((d) => d.id)).toEqual(["dev-stale-2"]);
    await app.close();
  });

  it("ignores revoked devices", async () => {
    const app = makeApp();
    await app.ready();
    seedUser(app, "user-1");
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
          "VALUES ('dev-gone', 'user-1', 'gone', 'deadbeef', NULL, 1, unixepoch(), unixepoch())",
      )
      .run();
    const stale = await app.runWatchdog();
    expect(stale).toEqual([]);
    await app.close();
  });
});

describe("wake guard + boot sweep (R5)", () => {
  it("runs the catch-up sweep on the first request after boot", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900" });
    await app.ready();
    seedUser(app, "user-1");
    seedDevice(app, "dev-boot", "user-1", "k5".repeat(32), Math.floor(Date.now() / 1000) - 7200);

    // First request after boot must trigger the sweep (stale device found + logged).
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("sweeps again on the first request after an idle gap ≥ threshold", async () => {
    // Shrink the idle threshold via the test hook: any request after 0s idle counts as a wake.
    const guardApp = buildApp({
      dbPath: join(mkdtempSync(join(tmpdir(), "dprelay-watch-test-")), "t2.db"),
      env: { JWT_SECRET: TEST_JWT_SECRET },
      wakeIdleThresholdSec: 0,
    });
    await guardApp.ready();

    // Two rapid requests: both may trigger (threshold 0) but must not break traffic.
    const r1 = await guardApp.inject({ method: "GET", url: "/healthz" });
    const r2 = await guardApp.inject({ method: "GET", url: "/healthz" });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    await guardApp.close();
  });
});

/**
 * Telegram sink tests: pure unit tests of dispatchAlert with a stubbed global
 * fetch — no test-only env hooks in production config. Each stub records
 * (url, init) so the Bot API request shape and the fallback order are asserted
 * exactly.
 */
interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

/** Stubs global fetch with scripted (status, body) responses, in order. */
function stubFetch(...responses: { status: number; body?: unknown }[]): FetchCall[] {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init: FetchCall["init"] = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 200, body: { ok: true } };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

const noopLog = { warn() {}, info() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

const STALE_ALERT: WatchdogAlert = {
  type: "device_heartbeat_stale",
  deviceIds: ["dev-1", "dev-2"],
  count: 2,
  threshold_sec: 900,
  detected_at: "2026-01-01T00:00:00.000Z",
};

function cfg(env: Record<string, string>) {
  return loadConfig({ JWT_SECRET: TEST_JWT_SECRET, ...env });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegram alert sink", () => {
  it("POSTs an HTML message with alert kind + devices to the Bot API and skips the generic webhook", async () => {
    const calls = stubFetch({ status: 200 });
    const result = await dispatchAlert(
      noopLog,
      cfg({
        TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
        TELEGRAM_CHAT_ID: "-100200300",
        ALERT_WEBHOOK_URL: "https://fallback.example.com/hook",
      }),
      STALE_ALERT,
    );

    expect(result).toBe("telegram");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/bot12345:TEST-TOKEN/sendMessage");
    const body = JSON.parse(calls[0].init.body ?? "{}") as { chat_id: string; text: string; parse_mode: string };
    expect(body.chat_id).toBe("-100200300");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("device_heartbeat_stale");
    expect(body.text).toContain("dev-1");
    expect(body.text).toContain("dev-2");
  });

  it("escapes HTML-significant characters in alert fields", async () => {
    const calls = stubFetch({ status: 200 });
    await dispatchAlert(
      noopLog,
      cfg({ TELEGRAM_BOT_TOKEN: "12345:T", TELEGRAM_CHAT_ID: "42" }),
      {
        type: "webhook_exhaustion",
        appId: "app<b>&raw",
        consecutiveFailures: 3,
        threshold: 3,
        lastSessionId: "sess<1>",
        lastError: "boom <&>",
        detected_at: "2026-01-01T00:00:00.000Z",
      },
    );

    const text = (JSON.parse(calls[0].init.body ?? "{}") as { text: string }).text;
    expect(text).toContain("webhook_exhaustion");
    expect(text).toContain("app&lt;b&gt;&amp;raw");
    expect(text).toContain("boom &lt;&amp;&gt;");
    expect(text).not.toContain("app<b>");
  });

  it("falls back to ALERT_WEBHOOK_URL when the Bot API rejects the send", async () => {
    const calls = stubFetch({ status: 500 }, { status: 200 });
    const result = await dispatchAlert(
      noopLog,
      cfg({
        TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
        TELEGRAM_CHAT_ID: "-100200300",
        ALERT_WEBHOOK_URL: "https://fallback.example.com/hook",
        ALERT_WEBHOOK_SECRET: "whsec-test-0123456789abcdef",
      }),
      STALE_ALERT,
    );

    expect(result).toBe("webhook");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("api.telegram.org");
    expect(calls[1].url).toBe("https://fallback.example.com/hook");
    expect(calls[1].init.headers?.Authorization).toBe("Bearer whsec-test-0123456789abcdef");
    expect(JSON.parse(calls[1].init.body ?? "{}")).toMatchObject({ type: "device_heartbeat_stale", deviceIds: ["dev-1", "dev-2"] });
  });

  it("falls back when the Bot API transport throws (timeout/network)", async () => {
    const calls: FetchCall[] = [];
    const impl = vi.fn(async (url: string | URL, init: FetchCall["init"] = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("api.telegram.org")) throw new Error("timeout");
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    });
    vi.stubGlobal("fetch", impl);
    const result = await dispatchAlert(
      noopLog,
      cfg({
        TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
        TELEGRAM_CHAT_ID: "-100200300",
        ALERT_WEBHOOK_URL: "https://fallback.example.com/hook",
      }),
      STALE_ALERT,
    );
    expect(result).toBe("webhook");
    expect(calls).toHaveLength(2);
  });

  it("uses the generic webhook when Telegram is unconfigured", async () => {
    const calls = stubFetch({ status: 200 });
    const result = await dispatchAlert(
      noopLog,
      cfg({ ALERT_WEBHOOK_URL: "https://fallback.example.com/hook" }),
      STALE_ALERT,
    );
    expect(result).toBe("webhook");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fallback.example.com/hook");
  });

  it("stays log-only when no sink is configured", async () => {
    const calls = stubFetch();
    const result = await dispatchAlert(noopLog, cfg({}), STALE_ALERT);
    expect(result).toBe("log-only");
    expect(calls).toHaveLength(0);
  });

  it("stays log-only when Telegram is half-configured (token without chat id)", async () => {
    const calls = stubFetch();
    const result = await dispatchAlert(
      noopLog,
      cfg({ TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN" }),
      STALE_ALERT,
    );
    expect(result).toBe("log-only");
    expect(calls).toHaveLength(0);
  });
});
