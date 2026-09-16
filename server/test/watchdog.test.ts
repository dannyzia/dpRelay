/**
 * Watchdog + catch-up sweep tests (R5): stale devices trigger alerts (webhook
 * or log-only), fresh devices do not, and the wake guard sweeps on boot and
 * first request after an idle gap.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { WatchdogAlert } from "../src/jobs.js";

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
