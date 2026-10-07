/**
 * ISSUE-56: replay a week of synthetic watchdog ticks and prove the alert
 * volume actually drops to near zero once abandoned enrolments are reaped.
 *
 * The watchdog runs every five minutes, so "is this alert noisy?" is a question
 * about a WEEK of ticks, not one tick — a three-tick unit test cannot answer it.
 * This harness drives the real `app.runWatchdog()` over 7 × 24 × 12 = 2016
 * fake-clock ticks and counts what the operator would actually receive, in two
 * arms of the same scenario:
 *
 *   - baseline: `DEVICE_QUARANTINE_SEC` is one year, so the reaper cannot fire
 *     inside the replay. This is a faithful pre-fix proxy: the same code path,
 *     with the fix disabled by configuration only.
 *   - fixed: the production default of 24h.
 *
 * Both arms seed 40 never-heartbeated enrolments created 30 days before the
 * replay. The baseline arm pages once an hour for the whole week (168 alerts);
 * the fixed arm reaps all 40 on the first tick and never alerts again (0). A
 * second test replays a week with a genuine outage device present, proving the
 * drop is not achieved by silencing real outages: the outage device keeps
 * paging while a mid-week abandoned enrolment mutes itself 24h after creation.
 *
 * Determinism: every timestamp is either seeded explicitly or driven through
 * `vi.setSystemTime`, the alert path is pinned to log-only so a developer's
 * shell can never turn the harness into a network caller, each arm gets a fresh
 * database, and every tick is accounted for as alert / suppressed / quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { findStaleDevices, resetStaleAlertDedupe } from "../src/jobs.js";
import { sha256Hex } from "../src/services/crypto.js";
import type { FastifyInstance } from "fastify";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "operator-test-secret-0123456789abcdef0123456789ab";

/** One tick every five minutes, matching the watchdog cron interval. */
const TICK_SEC = 300;
const DAY_SEC = 86_400;
/** Seven days of five-minute ticks. */
const WEEK_TICKS = (7 * DAY_SEC) / TICK_SEC; // 2016
/** Fixed Monday-midnight start (2026-01-05T00:00:00Z), aligned to the tick grid. */
const T0_SEC = Date.UTC(2026, 0, 5, 0, 0, 0) / 1000;
/** Pre-fix proxy: a quarantine age the reaper cannot reach inside one week. */
const NO_REAP_QUARANTINE_SEC = 365 * DAY_SEC;
/** Production default. */
const PROD_QUARANTINE_SEC = DAY_SEC;

/** Temp databases created by replays; cleaned up so the harness does not leak. */
const tempDirs: string[] = [];

beforeEach(() => {
  resetStaleAlertDedupe();
});

afterEach(() => {
  vi.useRealTimers();
  resetStaleAlertDedupe();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Seeds one device with fully explicit timestamps so the replay arithmetic is exact. */
function seedDevice(
  app: FastifyInstance,
  opts: { id: string; lastSeenAt: number | null; createdAt: number },
): void {
  app.db
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', unixepoch())")
    .run(`u-${opts.id}`, `${opts.id}@example.com`);
  app.db
    .prepare(
      "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, NULL, ?)",
    )
    .run(opts.id, `u-${opts.id}`, `phone-${opts.id}`, sha256Hex(`key-${opts.id}`), opts.lastSeenAt, opts.createdAt);
}

/** What one week of ticks did to the operator, measured from the real dispatch path. */
interface WeekReplay {
  /** `watchdog_alert` dispatches the operator would have received. */
  alerts: number;
  /** Ticks whose unchanged stale set was suppressed. */
  suppressed: number;
  /** Ticks with no stale devices at all. */
  quiet: number;
  /** Tick indexes (0-based) of each alert, for cadence and cutoff assertions. */
  alertTicks: number[];
  /** deviceIds carried by each alert, same order as `alertTicks`. */
  alertedDeviceIds: string[][];
  /** Reaper log batches and the ids they reported. */
  reapedBatches: number;
  reapedDeviceIds: string[];
  /** `quarantined_at` per device at the end of the week. */
  quarantinedAt: Map<string, number | null>;
  /** Devices still stale at the end of the week. */
  staleAtEnd: string[];
}

/**
 * Replays `WEEK_TICKS` fake-clock watchdog ticks and reports exactly what the
 * alert path did on each one.
 *
 * `quarantineSec` is the only knob that differs between the two arms, so any
 * difference in outcome is attributable to the reaper. The alert sinks are
 * explicitly blanked (not merely left unset) so an ambient `ALERT_WEBHOOK_URL`
 * or Telegram token in the developer's shell cannot make this nondeterministic.
 */
async function replayWeek(
  quarantineSec: number,
  seed: (app: FastifyInstance, t0Sec: number) => void,
): Promise<WeekReplay> {
  const dir = mkdtempSync(join(tmpdir(), "dprelay-weekreplay-"));
  tempDirs.push(dir);
  const app = buildApp({
    dbPath: join(dir, "test.db"),
    startCron: false,
    runBootSweep: false,
    enableWakeGuard: false,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: TEST_OPERATOR_SECRET,
      WATCHDOG_STALE_SEC: "900",
      WATCHDOG_ALERT_REPEAT_SEC: "3600",
      DEVICE_QUARANTINE_SEC: String(quarantineSec),
      ALERT_WEBHOOK_URL: "",
      ALERT_WEBHOOK_SECRET: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
    },
  });
  // Dedupe state is module-global and survives across apps in one test file,
  // so it must be cleared per arm or the second arm would inherit the first's
  // "already alerted" signature.
  resetStaleAlertDedupe();

  const out: WeekReplay = {
    alerts: 0,
    suppressed: 0,
    quiet: 0,
    alertTicks: [],
    alertedDeviceIds: [],
    reapedBatches: 0,
    reapedDeviceIds: [],
    quarantinedAt: new Map(),
    staleAtEnd: [],
  };

  // The watchdog reads its clock through Date.now() only, so faking Date moves
  // the entire replay while leaving real timers intact for fastify and
  // better-sqlite3. SQLite's unixepoch() is only ever written (job_state
  // updated_at) and never read on this path, so it cannot drift the results.
  vi.useFakeTimers({ toFake: ["Date"] });
  let tickIndex = -1;

  app.log.warn = ((obj: unknown, msg?: string) => {
    if (msg === "watchdog_alert") {
      out.alerts += 1;
      out.alertTicks.push(tickIndex);
      out.alertedDeviceIds.push((obj as { alert?: { deviceIds?: string[] } }).alert?.deviceIds ?? []);
    }
    return app.log;
  }) as typeof app.log.warn;
  app.log.info = ((obj: unknown, msg?: string) => {
    if (msg === "watchdog_alert_suppressed_unchanged_set") out.suppressed += 1;
    else if (msg === "no stale devices") out.quiet += 1;
    else if (msg?.startsWith("quarantined never-seen devices")) {
      out.reapedBatches += 1;
      out.reapedDeviceIds.push(...((obj as { deviceIds?: string[] }).deviceIds ?? []));
    }
    return app.log;
  }) as typeof app.log.info;

  try {
    seed(app, T0_SEC);
    for (let i = 0; i < WEEK_TICKS; i++) {
      tickIndex = i;
      vi.setSystemTime((T0_SEC + i * TICK_SEC) * 1000);
      await app.runWatchdog();
    }
    out.staleAtEnd = findStaleDevices(app.db, 900).map((d) => d.id);
    out.quarantinedAt = new Map(
      (
        app.db.prepare("SELECT id, quarantined_at FROM devices").all() as Array<{
          id: string;
          quarantined_at: number | null;
        }>
      ).map((row) => [row.id, row.quarantined_at]),
    );
  } finally {
    vi.useRealTimers();
    await app.close();
  }

  return out;
}

/**
 * Explicit budget for a 2016-tick replay. Each tick is sub-millisecond, but this
 * is ~2000 real database round-trips; the default 5s budget made the harness
 * flake roughly once in thirty runs on a loaded machine, which is exactly the
 * replay's own cost rather than a behaviour difference.
 */
const REPLAY_TIMEOUT_MS = 30_000;

describe("watchdog week replay", () => {
  it("pages 168 times across a week of abandoned enrolments, and zero times once they are reaped", async () => {
    const seedAbandonedBacklog = (app: FastifyInstance, t0: number): void => {
      for (let i = 0; i < 40; i++) {
        seedDevice(app, {
          id: `abandoned-${String(i).padStart(2, "0")}`,
          lastSeenAt: null,
          createdAt: t0 - 30 * DAY_SEC,
        });
      }
    };

    const baseline = await replayWeek(NO_REAP_QUARANTINE_SEC, seedAbandonedBacklog);
    const fixed = await replayWeek(PROD_QUARANTINE_SEC, seedAbandonedBacklog);

    // Baseline (pre-fix proxy): the backlog is stale from tick 0, the dedupe
    // re-alerts once an hour, and nothing ever mutes it — 168 pages in a week.
    expect(baseline.reapedBatches).toBe(0);
    expect(baseline.alerts).toBe(168);
    expect(baseline.alertTicks.slice(0, 3)).toEqual([0, 12, 24]);
    expect(baseline.alertTicks[baseline.alertTicks.length - 1]).toBe(2004);
    expect(baseline.suppressed).toBe(WEEK_TICKS - 168);
    expect(baseline.quiet).toBe(0);
    expect(baseline.staleAtEnd).toHaveLength(40);
    expect([...baseline.quarantinedAt.values()].every((at) => at === null)).toBe(true);

    // Every tick must land in exactly one bucket, so a silently dropped tick
    // cannot masquerade as a quiet one.
    expect(baseline.alerts + baseline.suppressed + baseline.quiet).toBe(WEEK_TICKS);

    // Fixed: the first tick reaps the whole backlog before it is ever evaluated
    // for staleness, and the week never pages again.
    expect(fixed.reapedBatches).toBe(1);
    expect(fixed.reapedDeviceIds).toHaveLength(40);
    expect(fixed.alerts).toBe(0);
    expect(fixed.alerts / baseline.alerts).toBeLessThan(0.05);
    expect(fixed.suppressed).toBe(0);
    expect(fixed.quiet).toBe(WEEK_TICKS);
    expect(fixed.alerts + fixed.suppressed + fixed.quiet).toBe(WEEK_TICKS);
    expect(fixed.staleAtEnd).toEqual([]);

    // The silence comes from quarantine, not from losing the devices: all 40
    // rows still exist and were muted on the first tick.
    expect(fixed.quarantinedAt.size).toBe(40);
    expect([...fixed.quarantinedAt.values()].every((at) => at === T0_SEC)).toBe(true);
  }, REPLAY_TIMEOUT_MS);

  it("keeps paging a real outage all week while a mid-week abandoned enrolment mutes itself", async () => {
    const GENUINE = "gateway-outage";
    const MIDWEEK = "midweek-enrolment";
    const MIDWEEK_CREATED = T0_SEC + 3 * DAY_SEC;
    // Created on the tick grid, so it is reaped exactly one tick after it
    // reaches the 24h quarantine age: `created_at < now - 86400` is strict.
    const MIDWEEK_REAP_TICK = (MIDWEEK_CREATED + DAY_SEC + TICK_SEC) / TICK_SEC;

    const fixed = await replayWeek(PROD_QUARANTINE_SEC, (app, t0) => {
      // Worked once, then went dark before the replay: a real outage signal.
      seedDevice(app, { id: GENUINE, lastSeenAt: t0 - 10_000, createdAt: t0 - 100_000 });
      // Enrolled mid-week and never heartbeats: an abandoned enrolment.
      seedDevice(app, { id: MIDWEEK, lastSeenAt: null, createdAt: MIDWEEK_CREATED });
    });

    expect(fixed.alerts + fixed.suppressed + fixed.quiet).toBe(WEEK_TICKS);

    // The real outage is never muted and pages at the hourly cadence all week.
    expect(fixed.quarantinedAt.get(GENUINE)).toBeNull();
    expect(fixed.alertedDeviceIds).toHaveLength(fixed.alerts);
    expect(fixed.alertedDeviceIds.every((ids) => ids.includes(GENUINE))).toBe(true);
    expect(fixed.alertedDeviceIds[fixed.alertedDeviceIds.length - 1]).toEqual([GENUINE]);
    // 169 = hourly cadence (168) plus two set-change alerts (join and reap).
    expect(fixed.alerts).toBe(169);

    // The abandoned enrolment alerts while stale, then goes quiet exactly 24h
    // after enrolment — and appears in no alert after the tick that reaps it.
    expect(fixed.quarantinedAt.get(MIDWEEK)).toBe(MIDWEEK_CREATED + DAY_SEC + TICK_SEC);
    expect(fixed.reapedDeviceIds).toEqual([MIDWEEK]);
    const midweekAlertTicks = fixed.alertTicks.filter((_, idx) =>
      fixed.alertedDeviceIds[idx].includes(MIDWEEK),
    );
    expect(midweekAlertTicks.length).toBeGreaterThan(0);
    expect(midweekAlertTicks.every((tick) => tick < MIDWEEK_REAP_TICK)).toBe(true);

    // End of week: only the genuine outage is still stale.
    expect(fixed.staleAtEnd).toEqual([GENUINE]);
  }, REPLAY_TIMEOUT_MS);
});