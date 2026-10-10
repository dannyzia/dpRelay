/**
 * Durable job-state regression tests (migration 011, `job_state`).
 *
 * Why this exists: both counters were in-process, so every redeploy silently
 * reset them to "healthy". For the alert sinks that is actively dangerous — a
 * receiver dead for an hour reported itself fine the instant a new build booted,
 * and /health/alerts returned 200 over a live outage. A monitoring signal that
 * goes green because nobody fixed the thing it is monitoring is worse than no
 * signal at all.
 *
 * The watchdog dedupe case is weaker: a restart used to produce one repeat
 * alert, which was argued to be the safe direction. That argument still holds
 * per-event, but "every deploy re-announces" is an alarm that trains people to
 * ignore it, so the dedupe is persisted too.
 *
 * The load-bearing assertions are the restart ones. A test that only checks "a
 * row was written" would pass even if nothing ever read that row back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import {
  alertSinkStatus,
  dispatchAlert,
  hydrateSinkHealth,
  resetAlertSinkHealth,
  type WatchdogAlert,
} from "../src/jobs.js";
import { ALERT_SINK_STATE_KEY, WATCHDOG_DEDUPE_STATE_KEY } from "../src/job-state.js";
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

/** One db path reused across "restarts" so state has somewhere to survive to. */
function dbPath(): string {
  return join(testTmpDir("dprelay-jobstate-"), "test.db");
}

function makeApp(path: string, env: Record<string, string> = {}): FastifyInstance {
  return buildApp({ dbPath: path, env: { JWT_SECRET: TEST_JWT_SECRET, ...env } });
}

const cfg = (env: Record<string, string>) => loadConfig({ JWT_SECRET: TEST_JWT_SECRET, ...env });

const noopLog = { warn() {}, info() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

/** Telegram configured, fetch forced to fail, so every dispatch misses. */
function stubFailingTelegram(): void {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Mirrors what a process restart does to memory.
  resetAlertSinkHealth();
});

describe("alert-sink counters survive a restart", () => {
  it("writes a row when a sink crosses the failure threshold", async () => {
    const path = dbPath();
    const app = makeApp(path, {
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "2",
    });
    const config = cfg({
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "2",
    });
    stubFailingTelegram();

    await dispatchAlert(noopLog, config, ALERT, app.db);
    const row = app.db
      .prepare("SELECT value FROM job_state WHERE key = ?")
      .get(ALERT_SINK_STATE_KEY) as { value: string } | undefined;
    expect(row, "one miss is below the threshold of 2, so nothing should be written yet").toBeUndefined();

    await dispatchAlert(noopLog, config, ALERT, app.db);
    const after = app.db
      .prepare("SELECT value FROM job_state WHERE key = ?")
      .get(ALERT_SINK_STATE_KEY) as { value: string };
    expect(JSON.parse(after.value).telegram.degradedSince).toEqual(expect.any(String));
    await app.close();
  });

  it("reports degraded after a restart, not healthy", async () => {
    const path = dbPath();
    const env = {
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "1",
    };
    const first = makeApp(path, env);
    stubFailingTelegram();
    await dispatchAlert(noopLog, cfg(env), ALERT, first.db);
    expect(alertSinkStatus(cfg(env)).degraded, "precondition: degraded in-process").toBe(true);
    await first.close();

    // The restart: memory is empty, only the database remembers.
    resetAlertSinkHealth();
    stubFailingTelegram();
    expect(
      alertSinkStatus(cfg(env)).degraded,
      "in-memory state alone is clean, which is the whole bug",
    ).toBe(false);

    hydrateSinkHealth(first.db);
    const status = alertSinkStatus(cfg(env));
    expect(status.degraded, "after rehydrating, a still-dead sink must not read healthy").toBe(true);
    expect(status.sinks.find((s) => s.sink === "telegram")?.consecutiveFailures).toBeGreaterThan(0);
  });

  it("clears the persisted row's degraded flag once a sink recovers", async () => {
    const path = dbPath();
    const env = {
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "1",
    };
    const app = makeApp(path, env);
    stubFailingTelegram();
    await dispatchAlert(noopLog, cfg(env), ALERT, app.db);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
    );
    await dispatchAlert(noopLog, cfg(env), ALERT, app.db);

    resetAlertSinkHealth();
    hydrateSinkHealth(app.db);
    expect(alertSinkStatus(cfg(env)).degraded, "a recovered sink must not come back degraded").toBe(false);
    await app.close();
  });

  it("never persists lastError", async () => {
    const path = dbPath();
    const env = {
      TELEGRAM_BOT_TOKEN: "12345:TEST-TOKEN",
      TELEGRAM_CHAT_ID: "-100200300",
      ALERT_SINK_FAILURE_THRESHOLD: "1",
    };
    const app = makeApp(path, env);
    stubFailingTelegram();
    await dispatchAlert(noopLog, cfg(env), ALERT, app.db);

    const row = app.db
      .prepare("SELECT value FROM job_state WHERE key = ?")
      .get(ALERT_SINK_STATE_KEY) as { value: string };
    // The transport's error text can carry a URL or a response body, and this
    // row is read on every boot.
    expect(row.value).not.toContain("lastError");
    expect(row.value).not.toContain("ECONNREFUSED");
    await app.close();
  });
});

describe("watchdog dedupe survives a restart", () => {
  it("writes the signature so a redeploy does not re-announce an unchanged set", async () => {
    const path = dbPath();
    const app = makeApp(path);
    const nowSec = Math.floor(Date.now() / 1000);
    app.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)")
      .run("u1", "ops@example.com", "x", nowSec);
    // last_seen_at must be SET and old. A never-seen device is quarantined by
    // quarantineNeverSeenDevices before the stale set is computed, so it would
    // be muted rather than alerted on — the wrong path for this test.
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, revocable, created_at, last_seen_at) " +
          "VALUES ('d1','u1','old',?,0,?,?)",
      )
      .run("a".repeat(64), nowSec - 100000, nowSec - 100000);

    await app.runWatchdog();
    const row = app.db
      .prepare("SELECT value FROM job_state WHERE key = ?")
      .get(WATCHDOG_DEDUPE_STATE_KEY) as { value: string } | undefined;
    expect(row, "the watchdog announced a stale device, so its dedupe must be recorded").toBeDefined();
    const parsed = JSON.parse(row!.value);
    expect(parsed.signature).toBe("d1");
    expect(typeof parsed.lastAlertAtMs).toBe("number");
    await app.close();
  });
});
