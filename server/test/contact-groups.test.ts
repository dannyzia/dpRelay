/**
 * Contact-group route tests (Stage E, ISSUE-74 AC2): CRUD happy paths, the
 * requireApp auth gate, per-request dedup, the 10k/group membership cap, and
 * the paginated phone listing — happy, auth-fail, and limit paths.
 *
 * FCM/wake concerns do not apply here; these routes are pure SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "cg-test-jwt-secret-0123456789abcdef0123456789ab";
const TEST_APP_ID = "app_cg_1";
const TEST_APP_SECRET = "cg-test-app-secret-0123456789abcdef0123456789ab";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-cg-test-")), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET, ...extra } });
}

function seedApp(app: FastifyInstance): void {
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, rate_max_per_phone, rate_window_sec, created_at) " +
        "VALUES ('cg-row-1', ?, ?, 'CG Test App', 3, 3600, unixepoch())",
    )
    .run(TEST_APP_ID, sha256Hex(TEST_APP_SECRET));
}

function appHeaders(secret = TEST_APP_SECRET): Record<string, string> {
  return { "x-app-id": TEST_APP_ID, "x-app-secret": secret };
}

function groupPhones(app: FastifyInstance, groupId: string): number {
  return (
    app.db.prepare("SELECT COUNT(*) AS n FROM contact_group_phones WHERE group_id = ?").get(groupId) as {
      n: number;
    }
  ).n;
}

let app: FastifyInstance;

beforeEach(() => {
  app = makeApp();
  seedApp(app);
});

afterEach(async () => {
  if (app) await app.close();
});

async function createGroup(name: string, phones: string[]) {
  return app.inject({
    method: "POST",
    url: "/v5/contact-groups",
    headers: appHeaders(),
    payload: { name, phones },
  });
}

const P1 = "+8801711111111";
const P2 = "+8801722222222";
const P3 = "+8801733333333";

describe("POST /v5/contact-groups", () => {
  it("creates a group, dedups phones and reports duplicateCount", async () => {
    const res = await createGroup("VT Group", [P1, P1, P2]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.groupId).toBe("string");
    expect(body.phoneCount).toBe(2);
    expect(body.duplicateCount).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${body.groupId as string}`,
      headers: appHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().group.phoneCount).toBe(2);
    expect(detail.json().group.phones.sort()).toEqual([P1, P2].sort());
  });

  it("400s on non-E.164 members and on an empty phone list", async () => {
    const bad = await createGroup("Bad", ["not-a-number"]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid_phones");
    const empty = await createGroup("Empty", []);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("invalid_phones");
    // Nothing persisted for either failure.
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM contact_groups").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("409s a duplicate name within the same app", async () => {
    expect((await createGroup("Dup", [P1])).statusCode).toBe(201);
    const again = await createGroup("Dup", [P2]);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("group_name_exists");
  });

  it("rejects unauthenticated and wrong-secret requests with 401", async () => {
    const noCreds = await app.inject({
      method: "POST",
      url: "/v5/contact-groups",
      payload: { name: "X", phones: [P1] },
    });
    expect(noCreds.statusCode).toBe(401);
    expect(noCreds.json().code).toBe("missing_app_credentials");
    const control = await createGroup("X", [P1]);
    const wrongRes = await app.inject({
      method: "POST",
      url: "/v5/contact-groups",
      headers: appHeaders("wrong-secret"),
      payload: { name: "Y", phones: [P1] },
    });
    expect(control.statusCode).toBe(201); // control: correct secret works
    expect(wrongRes.statusCode).toBe(401);
    expect(wrongRes.json().code).toBe("invalid_app_secret");
  });
});

describe("GET /v5/contact-groups (list)", () => {
  it("pages newest-first with a keyset cursor and yields every group exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await createGroup(`G${i}`, [P1]);
      expect(res.statusCode).toBe(201);
      ids.push(res.json().groupId as string);
      // Distinct created_at so DESC order is deterministic (same-second inserts tie).
      app.db.prepare("UPDATE contact_groups SET created_at = ? WHERE id = ?").run(1000 + i, ids[i]);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = cursor === null
        ? "/v5/contact-groups?limit=1"
        : `/v5/contact-groups?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.inject({ method: "GET", url, headers: appHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { groups: { groupId: string }[]; nextCursor: string | null };
      seen.push(...body.groups.map((g) => g.groupId));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    // Newest first: created_at 1002, 1001, 1000.
    expect(seen).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("rejects unauthenticated list requests with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v5/contact-groups" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v5/contact-groups/:id (detail)", () => {
  it("returns the group with all members", async () => {
    const created = await createGroup("Detail", [P1, P2]);
    const id = created.json().groupId as string;
    const res = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${id}`,
      headers: appHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().group).toMatchObject({ groupId: id, name: "Detail", phoneCount: 2 });
    expect(res.json().group.phones.sort()).toEqual([P1, P2].sort());
  });

  it("404s an unknown group and 400s a malformed id", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/v5/contact-groups/does-not-exist",
      headers: appHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("group_not_found");
    const malformed = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${"x".repeat(65)}`,
      headers: appHeaders(),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("invalid_group_id");
  });
});

describe("PATCH /v5/contact-groups/:id", () => {
  it("renames, 409s onto an existing name, 404s unknown", async () => {
    const a = (await createGroup("Alpha", [P1])).json().groupId as string;
    await createGroup("Beta", [P2]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v5/contact-groups/${a as string}`,
      headers: appHeaders(),
      payload: { name: "Alpha Renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Alpha Renamed");

    const conflict = await app.inject({
      method: "PATCH",
      url: `/v5/contact-groups/${a as string}`,
      headers: appHeaders(),
      payload: { name: "Beta" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("group_name_exists");

    const missing = await app.inject({
      method: "PATCH",
      url: "/v5/contact-groups/nope",
      headers: appHeaders(),
      payload: { name: "Whatever" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("DELETE /v5/contact-groups/:id", () => {
  it("deletes the group and cascades its phones", async () => {
    const id = (await createGroup("Doomed", [P1, P2])).json().groupId as string;
    expect(groupPhones(app, id)).toBe(2);
    const res = await app.inject({
      method: "DELETE",
      url: `/v5/contact-groups/${id}`,
      headers: appHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(groupPhones(app, id)).toBe(0);
    const again = await app.inject({
      method: "DELETE",
      url: `/v5/contact-groups/${id}`,
      headers: appHeaders(),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("POST /v5/contact-groups/:id/phones", () => {
  it("adds members with per-request dedup and refreshes phone_count", async () => {
    const id = (await createGroup("Members", [P1])).json().groupId as string;
    const res = await app.inject({
      method: "POST",
      url: `/v5/contact-groups/${id}/phones`,
      headers: appHeaders(),
      payload: { phones: [P2, P2, P3, P1] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().addedCount).toBe(2);
    expect(res.json().duplicateCount).toBe(2);
    const detail = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${id}`,
      headers: appHeaders(),
    });
    expect(detail.json().group.phoneCount).toBe(3);
  });

  it("rejects invalid E.164 atomically (nothing added) and 404s unknown groups", async () => {
    const id = (await createGroup("Guarded", [P1])).json().groupId as string;
    const bad = await app.inject({
      method: "POST",
      url: `/v5/contact-groups/${id}/phones`,
      headers: appHeaders(),
      payload: { phones: [P2, "nope"] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid_phones");
    expect(groupPhones(app, id)).toBe(1);

    const missing = await app.inject({
      method: "POST",
      url: "/v5/contact-groups/nope/phones",
      headers: appHeaders(),
      payload: { phones: [P2] },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("enforces the 10k/group cap: 409 and no partial add", async () => {
    // 10k distinct E.164 members in one create (the per-request limit allows it).
    const bulk = Array.from({ length: 10_000 }, (_, i) => `+100000000${String(i).padStart(3, "0")}`);
    const created = await createGroup("Huge", bulk);
    expect(created.statusCode).toBe(201);
    const id = created.json().groupId as string;
    expect(created.json().phoneCount).toBe(10_000);

    const overflow = await app.inject({
      method: "POST",
      url: `/v5/contact-groups/${id}/phones`,
      headers: appHeaders(),
      payload: { phones: [P1] },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().code).toBe("group_phone_limit");
    // Whole request rejected — the group still holds exactly 10k.
    expect(groupPhones(app, id)).toBe(10_000);
    const row = app.db
      .prepare("SELECT phone_count FROM contact_groups WHERE id = ?")
      .get(id) as { phone_count: number };
    expect(row.phone_count).toBe(10_000);
  }, 30_000);
});

describe("GET /v5/contact-groups/:id/phones (paginated listing)", () => {
  async function seededGroup(): Promise<string> {
    const id = (await createGroup("Paged", [P1, P2, P3, "+8801744444444", "+8801755555555"]))
      .json().groupId as string;
    // Distinct added_at so the keyset has a deterministic order to walk.
    const phones = app.db
      .prepare("SELECT phone FROM contact_group_phones WHERE group_id = ? ORDER BY phone ASC")
      .all(id) as { phone: string }[];
    phones.forEach((p, i) => {
      app.db
        .prepare("UPDATE contact_group_phones SET added_at = ? WHERE group_id = ? AND phone = ?")
        .run(1000 + i, id, p.phone);
    });
    return id;
  }

  it("pages by (added_at, phone) with a cursor until nextCursor is null", async () => {
    const id = await seededGroup();
    const ordered = app.db
      .prepare(
        "SELECT phone FROM contact_group_phones WHERE group_id = ? ORDER BY added_at ASC, phone ASC",
      )
      .all(id) as { phone: string }[];

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = cursor === null
        ? `/v5/contact-groups/${id}/phones?limit=2`
        : `/v5/contact-groups/${id}/phones?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.inject({ method: "GET", url, headers: appHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        phoneCount: number;
        phones: string[];
        nextCursor: string | null;
      };
      expect(body.phoneCount).toBe(5);
      expect(body.phones.length).toBeLessThanOrEqual(2);
      seen.push(...body.phones);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(ordered.map((p) => p.phone));
  });

  it("tie-breaks equal added_at by phone ascending", async () => {
    const id = await seededGroup();
    app.db.prepare("UPDATE contact_group_phones SET added_at = 500 WHERE group_id = ?").run(id);
    const res = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${id}/phones?limit=3`,
      headers: appHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { phones: string[]; nextCursor: string | null };
    expect(body.phones).toEqual([P1, P2, P3].sort());
    // Cursor points at the page's last member: (added_at, phone) keyset.
    expect(body.nextCursor).toBe(`500:${body.phones[2] as string}`);
  });

  it("404s unknown groups, 400s malformed ids, 401s without credentials", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/v5/contact-groups/nope/phones",
      headers: appHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${"x".repeat(65)}/phones`,
      headers: appHeaders(),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("invalid_group_id");
    const id = await seededGroup();
    const noCreds = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${id}/phones`,
    });
    expect(noCreds.statusCode).toBe(401);
  });

  it("falls back to the default limit on a garbage limit param", async () => {
    const id = await seededGroup();
    const res = await app.inject({
      method: "GET",
      url: `/v5/contact-groups/${id}/phones?limit=abc`,
      headers: appHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { phones: string[]; nextCursor: string | null };
    expect(body.phones).toHaveLength(5); // default 20 ≥ 5 → single page
    expect(body.nextCursor).toBeNull();
  });
});
