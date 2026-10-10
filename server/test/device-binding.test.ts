/**
 * STAGE F7 (ISSUE-87): device phone-number identity + per-app device binding.
 *
 * Ordered invariants (hub events 1316 + 1318 amendment):
 *  - enroll stores an E.164 phone number when valid (malformed ignored, absent
 *    fine), and rejects a number another device already holds (409);
 *  - POST /v5/device/phone-number sets/updates the calling device's number
 *    strictly (400 malformed, 409 collision) — the no-re-enroll path for the
 *    already-enrolled fleet;
 *  - every app creation route returns a per-app deviceEnrollmentSecret ONCE
 *    (digest only at rest) and the rotate route invalidates the old secret;
 *  - claim isolation lives in the fetch SQL: a bound device sees ONLY its own
 *    app's messages; an unbound device sees apps with no bound device (fleet
 *    fallback) plus NULL-app rows;
 *  - admin bind/unbind sets devices.app_id and the list surfaces
 *    number | bound-app for the panel.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "binding-test-jwt-0123456789abcdef0123456789abcdef";
const ENROLL_SECRET = "binding-enroll-secret-0123456789abcdef0123456789ab";
const OPERATOR = "binding-operator-secret-0123456789abcdef";
const PROVISIONING = "binding-provision-secret-0123456789abcdef";

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp({
    dbPath: join(testTmpDir("dprelay-binding-test-"), "test.db"),
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      DEVICE_ENROLLMENT_SECRET: ENROLL_SECRET,
      OPERATOR_SECRET: OPERATOR,
      APP_PROVISIONING_SECRET: PROVISIONING,
    },
  });
});

afterEach(async () => {
  await app.close();
});

/** Enrolls via the public route with an arbitrary bearer secret. */
async function enroll(secret: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v5/device/enroll",
    headers: { authorization: `Bearer ${secret}` },
    payload,
  });
}

/** Direct-seeds an app row with a known per-app device enrollment secret. */
function seedAppWithDeviceSecret(publicAppId: string, deviceSecret: string): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, device_enrollment_secret_hash, name, created_at) " +
        "VALUES (?, ?, ?, ?, ?, unixepoch())",
    )
    .run(id, publicAppId, sha256Hex(`${publicAppId}-secret`), sha256Hex(deviceSecret), publicAppId);
  return id;
}

/** Seeds a pending_sms row owned by a PUBLIC app id (or NULL for legacy). */
function seedPending(id: string, publicAppId: string | null, createdAt: number): void {
  app.db
    .prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
        "VALUES (?, ?, '+8801700000001', ?, 'pending', ?)",
    )
    .run(id, publicAppId, `msg-${id}`, createdAt);
}

async function fetchOutstanding(apiKey: string): Promise<string[]> {
  const res = await app.inject({
    method: "GET",
    url: "/v5/device/outstanding",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { messages: { id: string }[] };
  return body.messages.map((m) => m.id);
}

function op(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${OPERATOR}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe("POST /v5/device/enroll — phone number identity", () => {
  it("stores a valid E.164 phone number on the device", async () => {
    const res = await enroll(ENROLL_SECRET, { label: "redmi", phoneNumber: "+8801613249520" });
    expect(res.statusCode).toBe(201);
    const { deviceId } = res.json() as { deviceId: string };
    const row = app.db.prepare("SELECT phone_number FROM devices WHERE id = ?").get(deviceId) as {
      phone_number: string | null;
    };
    expect(row.phone_number).toBe("+8801613249520");
  });

  it("leaves phone_number NULL when the field is absent", async () => {
    const res = await enroll(ENROLL_SECRET, { label: "redmi" });
    expect(res.statusCode).toBe(201);
    const { deviceId } = res.json() as { deviceId: string };
    const row = app.db.prepare("SELECT phone_number FROM devices WHERE id = ?").get(deviceId) as {
      phone_number: string | null;
    };
    expect(row.phone_number).toBeNull();
  });

  it("ignores (does not reject) a present-but-malformed number", async () => {
    const res = await enroll(ENROLL_SECRET, { label: "redmi", phoneNumber: "01613249520" });
    expect(res.statusCode).toBe(201);
    const { deviceId } = res.json() as { deviceId: string };
    const row = app.db.prepare("SELECT phone_number FROM devices WHERE id = ?").get(deviceId) as {
      phone_number: string | null;
    };
    expect(row.phone_number).toBeNull();
  });

  it("409s a number another device already holds without creating a row", async () => {
    const first = await enroll(ENROLL_SECRET, { phoneNumber: "+8801613249520" });
    expect(first.statusCode).toBe(201);
    const before = (app.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;

    const second = await enroll(ENROLL_SECRET, { phoneNumber: "+8801613249520" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ ok: false, code: "phone_number_exists" });
    const after = (app.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("POST /v5/device/phone-number — no-re-enroll path for the live fleet", () => {
  async function enrolledKey(): Promise<string> {
    const res = await enroll(ENROLL_SECRET, {});
    expect(res.statusCode).toBe(201);
    return (res.json() as { apiKey: string }).apiKey;
  }

  it("sets then updates the calling device's number", async () => {
    const key = await enrolledKey();

    const set = await app.inject({
      method: "POST",
      url: "/v5/device/phone-number",
      headers: { authorization: `Bearer ${key}` },
      payload: { phoneNumber: "+8801711112222" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ ok: true, phoneNumber: "+8801711112222" });

    const update = await app.inject({
      method: "POST",
      url: "/v5/device/phone-number",
      headers: { authorization: `Bearer ${key}` },
      payload: { phoneNumber: "+8801833334444" },
    });
    expect(update.statusCode).toBe(200);

    const row = app.db.prepare("SELECT phone_number FROM devices WHERE api_key_hash = ?").get(sha256Hex(key)) as {
      phone_number: string | null;
    };
    expect(row.phone_number).toBe("+8801833334444");
  });

  it("400s a malformed number and leaves the stored value untouched", async () => {
    const key = await enrolledKey();
    await app.inject({
      method: "POST",
      url: "/v5/device/phone-number",
      headers: { authorization: `Bearer ${key}` },
      payload: { phoneNumber: "+8801711112222" },
    });

    const bad = await app.inject({
      method: "POST",
      url: "/v5/device/phone-number",
      headers: { authorization: `Bearer ${key}` },
      payload: { phoneNumber: "01711112222" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ ok: false, code: "invalid_phone_number" });

    const row = app.db.prepare("SELECT phone_number FROM devices WHERE api_key_hash = ?").get(sha256Hex(key)) as {
      phone_number: string | null;
    };
    expect(row.phone_number).toBe("+8801711112222");
  });

  it("409s when another device holds the number, 401s without a device key", async () => {
    const key = await enrolledKey();
    const other = await enroll(ENROLL_SECRET, { phoneNumber: "+8801999998888" });
    expect(other.statusCode).toBe(201);

    const clash = await app.inject({
      method: "POST",
      url: "/v5/device/phone-number",
      headers: { authorization: `Bearer ${key}` },
      payload: { phoneNumber: "+8801999998888" },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: "phone_number_exists" });

    const anon = await app.inject({
      method: "POST",
      url: "/v5/device/phone-number",
      payload: { phoneNumber: "+8801700000000" },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe("app-scoped enrollment secrets", () => {
  it("binds a device enrolled with an app secret; global secret stays unbound", async () => {
    seedAppWithDeviceSecret("app_alpha", "device-secret-alpha-0123456789abcdef");

    const bound = await enroll("device-secret-alpha-0123456789abcdef", { label: "money phone" });
    expect(bound.statusCode).toBe(201);
    const boundRow = app.db
      .prepare("SELECT app_id FROM devices WHERE id = ?")
      .get((bound.json() as { deviceId: string }).deviceId) as { app_id: string | null };
    expect(boundRow.app_id).not.toBeNull();

    const unbound = await enroll(ENROLL_SECRET, {});
    expect(unbound.statusCode).toBe(201);
    const unboundRow = app.db
      .prepare("SELECT app_id FROM devices WHERE id = ?")
      .get((unbound.json() as { deviceId: string }).deviceId) as { app_id: string | null };
    expect(unboundRow.app_id).toBeNull();
  });

  it("rotate-device-secret invalidates the old secret and mints a working one", async () => {
    seedAppWithDeviceSecret("app_beta", "device-secret-beta-0123456789abcdef");

    const apps = app.db.prepare("SELECT id FROM apps WHERE app_id = ?").get("app_beta") as { id: string };
    const rot = await op("POST", `/v5/admin/apps/${apps.id}/rotate-device-secret`);
    expect(rot.statusCode).toBe(200);
    const fresh = (rot.json() as { deviceEnrollmentSecret: string }).deviceEnrollmentSecret;
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);

    const old = await enroll("device-secret-beta-0123456789abcdef", {});
    expect(old.statusCode).toBe(401);

    const now = await enroll(fresh, {});
    expect(now.statusCode).toBe(201);
    const row = app.db
      .prepare("SELECT app_id FROM devices WHERE id = ?")
      .get((now.json() as { deviceId: string }).deviceId) as { app_id: string | null };
    expect(row.app_id).toBe(apps.id);
  });

  it("all three creation routes return deviceEnrollmentSecret once (digest at rest)", async () => {
    // Self-serve register (F3 plane).
    const reg = await app.inject({
      method: "POST",
      url: "/v5/auth/register",
      payload: { email: "binding@example.test", password: "correct-horse-battery-1" },
    });
    expect(reg.statusCode).toBe(201);
    const raw = reg.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(";")[0];
    const selfServe = await app.inject({
      method: "POST",
      url: "/v5/auth/apps",
      headers: { cookie },
      payload: { name: "self-serve" },
    });
    expect(selfServe.statusCode).toBe(201);
    const ssBody = selfServe.json() as { appId: string; deviceEnrollmentSecret: string };
    expect(ssBody.deviceEnrollmentSecret).toMatch(/^[0-9a-f]{64}$/);

    // Operator creation route.
    const admin = await op("POST", "/v5/admin/apps", { appId: "app_admin_create" });
    expect(admin.statusCode).toBe(201);
    const adminBody = admin.json() as { deviceEnrollmentSecret: string };
    expect(adminBody.deviceEnrollmentSecret).toMatch(/^[0-9a-f]{64}$/);

    // Provisioning route.
    const prov = await app.inject({
      method: "POST",
      url: "/v5/apps/register",
      headers: { authorization: `Bearer ${PROVISIONING}` },
      payload: { appId: "app_prov_create", appSecret: "prov-app-secret-0123456789abcdef0123456" },
    });
    expect(prov.statusCode).toBe(201);
    expect((prov.json() as { deviceEnrollmentSecret: string }).deviceEnrollmentSecret).toMatch(
      /^[0-9a-f]{64}$/,
    );

    // Digest only at rest: no apps row stores the raw secret.
    for (const [publicId, rawSecret] of [
      ["app_admin_create", adminBody.deviceEnrollmentSecret],
      ["app_prov_create", (prov.json() as { deviceEnrollmentSecret: string }).deviceEnrollmentSecret],
    ] as const) {
      const row = app.db
        .prepare("SELECT device_enrollment_secret_hash FROM apps WHERE app_id = ?")
        .get(publicId) as { device_enrollment_secret_hash: string | null };
      expect(row.device_enrollment_secret_hash).toBe(sha256Hex(rawSecret));
      expect(row.device_enrollment_secret_hash).not.toBe(rawSecret);
    }
  });
});

describe("outstanding fetch — claim isolation (fetch-SQL rule)", () => {
  it("bound device sees ONLY its app's messages; unbound sees fleet apps + NULL rows", async () => {
    seedAppWithDeviceSecret("app_owner_a", "device-secret-owner-a-0123456789abcdef");
    // app_owner_b exists but has NO bound device (fleet-eligible).
    seedAppWithDeviceSecret("app_owner_b", "device-secret-owner-b-0123456789abcdef");

    seedPending("row-a", "app_owner_a", 1000);
    seedPending("row-b", "app_owner_b", 2000);
    seedPending("row-legacy", null, 3000);

    const bound = await enroll("device-secret-owner-a-0123456789abcdef", {});
    expect(bound.statusCode).toBe(201);
    const boundKey = (bound.json() as { apiKey: string }).apiKey;

    const fleet = await enroll(ENROLL_SECRET, {});
    expect(fleet.statusCode).toBe(201);
    const fleetKey = (fleet.json() as { apiKey: string }).apiKey;

    // A fresh device fetches first so neither list is emptied by the other.
    expect(await fetchOutstanding(boundKey)).toEqual(["row-a"]);
    expect(await fetchOutstanding(fleetKey)).toEqual(["row-b", "row-legacy"]);
  });

  it("once an app gains a bound device, its rows disappear from the fleet fallback", async () => {
    seedAppWithDeviceSecret("app_owner_c", "device-secret-owner-c-0123456789abcdef");
    seedPending("row-c1", "app_owner_c", 1000);

    const fleet = await enroll(ENROLL_SECRET, {});
    const fleetKey = (fleet.json() as { apiKey: string }).apiKey;

    // Before binding: fleet device still sees app_owner_c (no bound device).
    expect(await fetchOutstanding(fleetKey)).toEqual(["row-c1"]);

    // Bind a device to app_owner_c; a NEW pending row must now be invisible
    // to any unbound device.
    const bound = await enroll("device-secret-owner-c-0123456789abcdef", {});
    const boundKey = (bound.json() as { apiKey: string }).apiKey;
    seedPending("row-c2", "app_owner_c", 2000);

    expect(await fetchOutstanding(fleetKey)).toEqual([]);
    expect(await fetchOutstanding(boundKey)).toEqual(["row-c2"]);
  });
});

describe("admin bind/unbind + devices list", () => {
  async function someDevice(): Promise<{ id: string }> {
    const res = await enroll(ENROLL_SECRET, { phoneNumber: "+8801555000011" });
    expect(res.statusCode).toBe(201);
    return { id: (res.json() as { deviceId: string }).deviceId };
  }

  it("binds, lists number | bound-app, and unbinds", async () => {
    seedAppWithDeviceSecret("app_bindme", "device-secret-bindme-0123456789abcdef");
    const device = await someDevice();

    const bind = await op("POST", `/v5/admin/devices/${device.id}/bind`, { appId: "app_bindme" });
    expect(bind.statusCode).toBe(200);
    expect(bind.json()).toMatchObject({ ok: true, boundAppId: "app_bindme" });

    const list = await op("GET", "/v5/admin/devices");
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      devices: {
        id: string;
        phoneNumber: string | null;
        boundAppId: string | null;
        boundAppName: string | null;
      }[];
    };
    const row = body.devices.find((d) => d.id === device.id);
    expect(row).toBeDefined();
    expect(row?.phoneNumber).toBe("+8801555000011");
    expect(row?.boundAppId).toBe("app_bindme");
    expect(row?.boundAppName).toBe("app_bindme");

    const unbind = await op("POST", `/v5/admin/devices/${device.id}/bind`, { appId: null });
    expect(unbind.statusCode).toBe(200);
    expect(unbind.json()).toMatchObject({ ok: true, boundAppId: null });

    const after = await op("GET", "/v5/admin/devices");
    const rowAfter = (after.json() as typeof body).devices.find((d) => d.id === device.id);
    expect(rowAfter?.boundAppId).toBeNull();
  });

  it("404s unknown device/app and 400s a non-string appId", async () => {
    const device = await someDevice();

    const badDevice = await op("POST", "/v5/admin/devices/nope/bind", { appId: null });
    expect(badDevice.statusCode).toBe(404);

    const badApp = await op("POST", `/v5/admin/devices/${device.id}/bind`, { appId: "ghost_app" });
    expect(badApp.statusCode).toBe(404);
    expect(badApp.json()).toMatchObject({ code: "app_not_found" });

    const badType = await op("POST", `/v5/admin/devices/${device.id}/bind`, { appId: 123 });
    expect(badType.statusCode).toBe(400);
  });
});
