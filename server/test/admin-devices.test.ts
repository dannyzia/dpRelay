/**
 * ISSUE-38: device lifecycle — never-seen grace, watchdog alert dedupe, and the
 * operator levers (list / revoke) that were missing entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { findStaleDevices, resetStaleAlertDedupe } from "../src/jobs.js";
import { sha256Hex } from "../src/services/crypto.js";
import type { FastifyInstance } from "fastify";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "operator-test-secret-0123456789abcdef0123456789ab";
const OP = { Authorization: "Bearer " + TEST_OPERATOR_SECRET };

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-admdev-")), "test.db");
  return buildApp({
    dbPath,
    env: { JWT_SECRET: TEST_JWT_SECRET, OPERATOR_SECRET: TEST_OPERATOR_SECRET, ...extra },
  });
}

function seedUser(app: FastifyInstance, id: string): void {
  app.db
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'test-hash', unixepoch())")
    .run(id, `owner-${id}@example.com`);
}

/**
 * Seeds a device with fully explicit timestamps so the grace boundary can be
 * asserted exactly rather than against a moving clock.
 */
function seedDevice(
  app: FastifyInstance,
  opts: { id: string; userId?: string | null; lastSeenAt: number | null; createdAt?: number; revocable?: number },
): void {
  seedUser(app, opts.userId ?? `u-${opts.id}`);
  app.db
    .prepare(
      "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .run(
      opts.id,
      opts.userId === null ? null : (opts.userId ?? `u-${opts.id}`),
      `phone-${opts.id}`,
      sha256Hex(`key-${opts.id}`),
      opts.lastSeenAt,
      opts.revocable ?? 1,
      opts.createdAt ?? Math.floor(Date.now() / 1000),
    );
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

beforeEach(() => {
  resetStaleAlertDedupe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStaleAlertDedupe();
});

describe("never-seen grace", () => {
  it("does NOT flag a device enrolled moments ago that has never heartbeaten", async () => {
    const app = makeApp();
    seedDevice(app, { id: "fresh", lastSeenAt: null, createdAt: nowSec() });
    expect(findStaleDevices(app.db, 900)).toHaveLength(0);
    await app.close();
  });

  it("flags a never-seen device once it is older than the staleness threshold", async () => {
    const app = makeApp();
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - 10_000 });
    const stale = findStaleDevices(app.db, 900);
    expect(stale.map((d) => d.id)).toEqual(["ancient"]);
    await app.close();
  });

  it("still flags a device whose heartbeat is old, on its own clock", async () => {
    const app = makeApp();
    seedDevice(app, { id: "seen-but-old", lastSeenAt: nowSec() - 5_000, createdAt: nowSec() - 100_000 });
    expect(findStaleDevices(app.db, 900).map((d) => d.id)).toEqual(["seen-but-old"]);
    await app.close();
  });

  it("excludes revoked devices from staleness", async () => {
    const app = makeApp();
    seedDevice(app, { id: "gone", lastSeenAt: nowSec() - 5_000 });
    app.db.prepare("UPDATE devices SET revoked_at = unixepoch() WHERE id = ?").run("gone");
    expect(findStaleDevices(app.db, 900)).toHaveLength(0);
    await app.close();
  });

  it("treats the grace boundary as strictly older than the threshold", async () => {
    const app = makeApp();
    // created exactly at the cutoff boundary: `created_at < cutoff` is false.
    seedDevice(app, { id: "boundary", lastSeenAt: null, createdAt: nowSec() - 900 });
    expect(findStaleDevices(app.db, 900)).toHaveLength(0);
    await app.close();
  });
});

describe("watchdog alert dedupe", () => {
  it("suppresses a repeat alert while the stale set is unchanged", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", WATCHDOG_ALERT_REPEAT_SEC: "3600" });
    seedDevice(app, { id: "d1", lastSeenAt: nowSec() - 5_000 });

    const alerts: string[] = [];
    app.log.warn = ((obj: unknown, msg?: string) => {
      if (msg === "watchdog_alert") alerts.push("watchdog_alert");
      return app.log;
    }) as typeof app.log.warn;
    app.log.info = ((obj: unknown, msg?: string) => {
      if (msg === "watchdog_alert_suppressed_unchanged_set") alerts.push("suppressed");
      return app.log;
    }) as typeof app.log.info;

    await app.runWatchdog();
    await app.runWatchdog();
    await app.runWatchdog();

    expect(alerts.filter((a) => a === "watchdog_alert")).toHaveLength(1);
    expect(alerts.filter((a) => a === "suppressed")).toHaveLength(2);
    await app.close();
  });

  it("re-alerts as soon as the stale set changes", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", WATCHDOG_ALERT_REPEAT_SEC: "3600" });
    seedDevice(app, { id: "d1", lastSeenAt: nowSec() - 5_000 });

    const alerts: string[] = [];
    app.log.warn = ((obj: unknown, msg?: string) => {
      if (msg === "watchdog_alert") alerts.push("watchdog_alert");
      return app.log;
    }) as typeof app.log.warn;

    await app.runWatchdog();
    // A second device goes stale: the set changed, so this must alert again.
    seedDevice(app, { id: "d2", lastSeenAt: nowSec() - 5_000 });
    await app.runWatchdog();

    expect(alerts).toHaveLength(2);
    await app.close();
  });

  it("re-alerts an unchanged set once the repeat interval elapses", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", WATCHDOG_ALERT_REPEAT_SEC: "1" });
    seedDevice(app, { id: "d1", lastSeenAt: nowSec() - 5_000 });

    const alerts: string[] = [];
    app.log.warn = ((obj: unknown, msg?: string) => {
      if (msg === "watchdog_alert") alerts.push("watchdog_alert");
      return app.log;
    }) as typeof app.log.warn;

    await app.runWatchdog();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1_100);
    await app.runWatchdog();
    vi.useRealTimers();

    expect(alerts).toHaveLength(2);
    await app.close();
  });

  it("re-alerts immediately after the stale set recovers, rather than staying silent", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", WATCHDOG_ALERT_REPEAT_SEC: "3600" });
    seedDevice(app, { id: "d1", lastSeenAt: nowSec() - 5_000 });

    const alerts: string[] = [];
    app.log.warn = ((obj: unknown, msg?: string) => {
      if (msg === "watchdog_alert") alerts.push("watchdog_alert");
      return app.log;
    }) as typeof app.log.warn;

    await app.runWatchdog();
    // d1 recovers — a clean tick must clear the dedupe baseline.
    app.db.prepare("UPDATE devices SET last_seen_at = unixepoch() WHERE id = ?").run("d1");
    await app.runWatchdog();
    // d1 goes stale again: this is a NEW condition, so it must alert.
    app.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowSec() - 5_000, "d1");
    await app.runWatchdog();

    expect(alerts).toHaveLength(2);
    await app.close();
  });
});

describe("GET /v5/admin/devices", () => {
  it("resolves staleness server-side and flags never-seen separately from stale", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900" });
    seedDevice(app, { id: "fresh", lastSeenAt: null, createdAt: nowSec() });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - 10_000 });
    seedDevice(app, { id: "old", lastSeenAt: nowSec() - 5_000 });

    const r = await app.inject({ method: "GET", url: "/v5/admin/devices", headers: OP });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      total: number;
      staleCount: number;
      neverSeenCount: number;
      staleThresholdSec: number;
      devices: { id: string; stale: boolean; neverSeen: boolean }[];
    };
    expect(body.staleThresholdSec).toBe(900);
    expect(body.total).toBe(3);
    expect(body.staleCount).toBe(2);
    expect(body.neverSeenCount).toBe(2);
    const byId = Object.fromEntries(body.devices.map((d) => [d.id, d]));
    expect(byId.fresh).toMatchObject({ stale: false, neverSeen: true });
    expect(byId.ancient).toMatchObject({ stale: true, neverSeen: true });
    expect(byId.old).toMatchObject({ stale: true, neverSeen: false });
    await app.close();
  });

  it("reports exactly the devices the watchdog would flag, revoked ones included", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900" });
    seedDevice(app, { id: "fresh", lastSeenAt: null, createdAt: nowSec() });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - 10_000 });
    seedDevice(app, { id: "old", lastSeenAt: nowSec() - 5_000 });
    seedDevice(app, { id: "revoked-old", lastSeenAt: nowSec() - 5_000 });
    app.db.prepare("UPDATE devices SET revoked_at = unixepoch() WHERE id = ?").run("revoked-old");

    // The invariant: the operator list and the alerting path read the same query,
    // so an operator can never be shown a device set the watchdog disagrees with.
    const watchdogSet = findStaleDevices(app.db, 900).map((d) => d.id).sort();
    const r = await app.inject({
      method: "GET",
      url: "/v5/admin/devices?includeRevoked=true",
      headers: OP,
    });
    const body = r.json() as { devices: { id: string; stale: boolean }[] };
    const listedStale = body.devices.filter((d) => d.stale).map((d) => d.id).sort();
    expect(listedStale).toEqual(watchdogSet);
    // A revoked device is visible on request but must never claim to be alerting.
    expect(body.devices.find((d) => d.id === "revoked-old")?.stale).toBe(false);
    await app.close();
  });

  it("filters to stale only on request", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900" });
    seedDevice(app, { id: "fresh", lastSeenAt: null, createdAt: nowSec() });
    seedDevice(app, { id: "old", lastSeenAt: nowSec() - 5_000 });

    const r = await app.inject({ method: "GET", url: "/v5/admin/devices?stale=true", headers: OP });
    const body = r.json() as { devices: { id: string }[] };
    expect(body.devices.map((d) => d.id)).toEqual(["old"]);
    await app.close();
  });

  it("hides revoked devices unless asked", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900" });
    seedDevice(app, { id: "gone", lastSeenAt: nowSec() - 5_000 });
    app.db.prepare("UPDATE devices SET revoked_at = unixepoch() WHERE id = ?").run("gone");

    const hidden = await app.inject({ method: "GET", url: "/v5/admin/devices", headers: OP });
    expect((hidden.json() as { devices: unknown[] }).devices).toHaveLength(0);

    const shown = await app.inject({
      method: "GET",
      url: "/v5/admin/devices?includeRevoked=true",
      headers: OP,
    });
    expect((shown.json() as { devices: unknown[] }).devices).toHaveLength(1);
    await app.close();
  });

  it("401s without the operator secret and 503s when it is unset", async () => {
    const app = makeApp();
    const anon = await app.inject({ method: "GET", url: "/v5/admin/devices" });
    expect(anon.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "GET",
      url: "/v5/admin/devices",
      headers: { Authorization: "Bearer wrong-secret-0123456789abcdef01234567" },
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();

    const disabled = makeApp({ OPERATOR_SECRET: "" });
    const off = await disabled.inject({
      method: "GET",
      url: "/v5/admin/devices",
      headers: { Authorization: "Bearer anything" },
    });
    expect(off.statusCode).toBe(503);
    await disabled.close();
  });
});

describe("POST /v5/admin/devices/:id/revoke", () => {
  it("revokes a stale device so the watchdog stops flagging it", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900" });
    seedDevice(app, { id: "dead-phone", lastSeenAt: nowSec() - 5_000 });
    expect(findStaleDevices(app.db, 900)).toHaveLength(1);

    const r = await app.inject({
      method: "POST",
      url: "/v5/admin/devices/dead-phone/revoke",
      headers: OP,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, deviceId: "dead-phone", revoked: true, alreadyRevoked: false });
    expect(findStaleDevices(app.db, 900)).toHaveLength(0);
    await app.close();
  });

  it("is idempotent so a retried operator script does not have to read first", async () => {
    const app = makeApp();
    seedDevice(app, { id: "d1", lastSeenAt: null });
    await app.inject({ method: "POST", url: "/v5/admin/devices/d1/revoke", headers: OP });
    const second = await app.inject({ method: "POST", url: "/v5/admin/devices/d1/revoke", headers: OP });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ revoked: true, alreadyRevoked: true });
    await app.close();
  });

  it("refuses a device marked non-revocable", async () => {
    const app = makeApp();
    seedDevice(app, { id: "permanent", lastSeenAt: null, revocable: 0 });
    const r = await app.inject({ method: "POST", url: "/v5/admin/devices/permanent/revoke", headers: OP });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ ok: false, code: "device_not_revocable" });
    await app.close();
  });

  it("404s an unknown device and 400s a malformed id", async () => {
    const app = makeApp();
    const missing = await app.inject({ method: "POST", url: "/v5/admin/devices/nope/revoke", headers: OP });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "device_not_found" });

    const empty = await app.inject({ method: "POST", url: "/v5/admin/devices//revoke", headers: OP });
    expect([400, 404]).toContain(empty.statusCode);
    await app.close();
  });

  it("401s without the operator secret", async () => {
    const app = makeApp();
    seedDevice(app, { id: "d1", lastSeenAt: null });
    const r = await app.inject({ method: "POST", url: "/v5/admin/devices/d1/revoke" });
    expect(r.statusCode).toBe(401);
    // And the row must be untouched.
    const row = app.db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get("d1") as {
      revoked_at: number | null;
    };
    expect(row.revoked_at).toBeNull();
    await app.close();
  });
});
