/**
 * ISSUE-38 follow-on: silent, self-healing quarantine for never-heartbeated
 * devices.
 *
 * The contract these tests pin is deliberately narrow, because the tempting
 * version of this feature is dangerous:
 *   - a device that has NEVER heartbeaten and is past the age is muted;
 *   - a device that worked once and then went quiet is NEVER muted — that is a
 *     real outage signal, and reaping it could cut over the only live gateway;
 *   - quarantine is not revocation: the device still authenticates, and one
 *     heartbeat clears it;
 *   - a revoked device is never quarantined, and cannot be unquarantined.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { findStaleDevices, quarantineNeverSeenDevices, resetStaleAlertDedupe } from "../src/jobs.js";
import { sha256Hex } from "../src/services/crypto.js";
import type { FastifyInstance } from "fastify";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const TEST_OPERATOR_SECRET = "operator-test-secret-0123456789abcdef0123456789ab";
const OP = { Authorization: "Bearer " + TEST_OPERATOR_SECRET };
const DAY = 86_400;

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-quarantine-")), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET, OPERATOR_SECRET: TEST_OPERATOR_SECRET, ...extra } });
}

/** Seeds a device; raw key is hashed, never stored. */
function seedDevice(
  app: FastifyInstance,
  opts: { id: string; lastSeenAt: number | null; createdAt: number; revocable?: number; revoked?: boolean },
): void {
  app.db
    .prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', unixepoch())",
    )
    .run(`u-${opts.id}`, `${opts.id}@example.com`);
  app.db
    .prepare(
      "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.id,
      `u-${opts.id}`,
      `phone-${opts.id}`,
      sha256Hex(`key-${opts.id}`),
      opts.lastSeenAt,
      opts.revocable ?? 1,
      opts.revoked ? Math.floor(Date.now() / 1000) : null,
      opts.createdAt,
    );
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

beforeEach(() => {
  resetStaleAlertDedupe();
});

describe("quarantine reaper", () => {
  it("quarantines a never-heartbeated device past the quarantine age", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });
    const reaped = quarantineNeverSeenDevices(app.db, DAY);
    expect(reaped).toEqual(["ancient"]);
    const row = app.db.prepare("SELECT quarantined_at FROM devices WHERE id = ?").get("ancient") as {
      quarantined_at: number | null;
    };
    expect(row.quarantined_at).not.toBeNull();
    await app.close();
  });

  it("leaves a freshly enrolled never-seen device alone", async () => {
    const app = makeApp({ DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "fresh", lastSeenAt: null, createdAt: nowSec() - 60 });
    expect(quarantineNeverSeenDevices(app.db, DAY)).toEqual([]);
    await app.close();
  });

  it("never quarantines a device that has heartbeaten before, however long it has been silent", async () => {
    const app = makeApp({ DEVICE_QUARANTINE_SEC: String(DAY) });
    // Worked once, then went dark a month ago. That is an outage signal, not an
    // abandoned enrolment — reaping it would cut over the only live gateway.
    seedDevice(app, { id: "went-dark", lastSeenAt: nowSec() - 30 * DAY, createdAt: nowSec() - 60 * DAY });
    expect(quarantineNeverSeenDevices(app.db, DAY)).toEqual([]);
    await app.close();
  });

  it("never quarantines a revoked device", async () => {
    const app = makeApp({ DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "gone", lastSeenAt: null, createdAt: nowSec() - 10 * DAY, revoked: true });
    expect(quarantineNeverSeenDevices(app.db, DAY)).toEqual([]);
    await app.close();
  });

  it("reports only the rows it actually changed", async () => {
    const app = makeApp({ DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "first", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });
    seedDevice(app, { id: "second", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });
    expect(quarantineNeverSeenDevices(app.db, DAY).sort()).toEqual(["first", "second"]);
    // Second pass changes nothing, so a repeated log line cannot imply churn.
    expect(quarantineNeverSeenDevices(app.db, DAY)).toEqual([]);
    await app.close();
  });
});

describe("quarantine suppresses alerting but not authentication", () => {
  it("drops a quarantined device out of the stale set the watchdog alerts on", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });

    // Before reaping it is stale and would alert.
    expect(findStaleDevices(app.db, 900).map((d) => d.id)).toEqual(["ancient"]);

    await app.runWatchdog();

    // After the watchdog's own reaper ran, it is gone from the stale set, so the
    // same tick alerts about nothing.
    expect(findStaleDevices(app.db, 900)).toEqual([]);
    await app.close();
  });

  it("still lets a quarantined device authenticate and self-heal on heartbeat", async () => {
    const app = makeApp({ DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });
    quarantineNeverSeenDevices(app.db, DAY);
    const quarantined = app.db.prepare("SELECT quarantined_at FROM devices WHERE id = ?").get("ancient") as {
      quarantined_at: number | null;
    };
    expect(quarantined.quarantined_at).not.toBeNull();

    // Quarantine is mute, not disable: the raw key still authenticates.
    const res = await app.inject({
      method: "POST",
      url: "/v5/device/heartbeat",
      headers: { Authorization: "Bearer key-ancient" },
    });
    expect(res.statusCode).toBe(200);

    // And the heartbeat clears the quarantine.
    const after = app.db.prepare("SELECT quarantined_at, last_seen_at FROM devices WHERE id = ?").get("ancient") as {
      quarantined_at: number | null;
      last_seen_at: number | null;
    };
    expect(after.quarantined_at).toBeNull();
    expect(after.last_seen_at).not.toBeNull();
    await app.close();
  });
});

describe("operator device plane", () => {
  it("reports quarantine state on the device list", async () => {
    const app = makeApp({ WATCHDOG_STALE_SEC: "900", DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });
    seedDevice(app, { id: "fresh", lastSeenAt: null, createdAt: nowSec() - 60 });
    quarantineNeverSeenDevices(app.db, DAY);

    const res = await app.inject({ method: "GET", url: "/v5/admin/devices", headers: OP });
    const body = res.json() as {
      quarantineSec: number;
      quarantinedCount: number;
      devices: { id: string; quarantined: boolean; stale: boolean }[];
    };
    expect(body.quarantineSec).toBe(DAY);
    expect(body.quarantinedCount).toBe(1);
    const byId = Object.fromEntries(body.devices.map((d) => [d.id, d]));
    expect(byId.ancient).toMatchObject({ quarantined: true, stale: false });
    expect(byId.fresh).toMatchObject({ quarantined: false });
    await app.close();
  });

  it("clears a quarantine on request, and refuses to touch a revoked device", async () => {
    const app = makeApp({ DEVICE_QUARANTINE_SEC: String(DAY) });
    seedDevice(app, { id: "ancient", lastSeenAt: null, createdAt: nowSec() - DAY - 60 });
    seedDevice(app, { id: "gone", lastSeenAt: null, createdAt: nowSec() - DAY - 60, revoked: true });
    quarantineNeverSeenDevices(app.db, DAY);

    const clear = await app.inject({ method: "POST", url: "/v5/admin/devices/ancient/unquarantine", headers: OP });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toMatchObject({ ok: true, quarantined: false, alreadyClear: false });

    // Idempotent on retry, so an operator script need not read state first.
    const again = await app.inject({ method: "POST", url: "/v5/admin/devices/ancient/unquarantine", headers: OP });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, alreadyClear: true });

    const revoked = await app.inject({ method: "POST", url: "/v5/admin/devices/gone/unquarantine", headers: OP });
    expect(revoked.statusCode).toBe(409);
    expect((revoked.json() as { code: string }).code).toBe("device_revoked");

    const missing = await app.inject({ method: "POST", url: "/v5/admin/devices/nope/unquarantine", headers: OP });
    expect(missing.statusCode).toBe(404);

    const unauth = await app.inject({ method: "POST", url: "/v5/admin/devices/ancient/unquarantine" });
    expect(unauth.statusCode).toBe(401);
    await app.close();
  });
});
