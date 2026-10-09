/**
 * STAGE F5 (ISSUE-83) → F5 amendment (ISSUE-89, RATIFIED hub event 1319):
 * package CRUD. Ordered invariants: PATCH edits whitelisted fields (404
 * unknown, 400 malformed); DELETE is SAFE DELETE — 409 package_in_use for any
 * package a transaction references (financial history → retire-only,
 * permanently), hard-delete only for never-used packages. The dedicated
 * POST …/retire endpoint soft-retires regardless of references, and a retired
 * package's existing transactions still approve from their snapshots.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "pkgcrud-test-jwt-0123456789abcdef0123456789abcdef";
const OPERATOR = "pkgcrud-operator-secret-0123456789abcdef";
const BKASH = "+8801711000000";

const CRED = {
  "x-app-id": "app_pkg",
  "x-app-secret": "secret-pkg-0123456789abcdef0123456789abcdef",
};
const PKG = {
  packageCode: "otp100",
  name: "OTP 100",
  smsQuota: 100,
  priceBdt: 200,
  validityDays: 30,
  type: "otp",
};

let app: FastifyInstance;

function op(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${OPERATOR}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Creates the package and returns a pending purchase's transactionId. */
async function setupWithTransaction(): Promise<string> {
  const up = await op("POST", "/v5/admin/billing/packages", PKG);
  expect(up.statusCode).toBe(201);
  const req = await app.inject({
    method: "POST",
    url: "/v5/billing/credits/request",
    headers: CRED,
    payload: { packageCode: PKG.packageCode },
  });
  expect(req.statusCode).toBe(201);
  return (req.json() as { transactionId: string }).transactionId;
}

function packageRow(code: string): { is_active: number; price_bdt: number; sms_quota: number } | undefined {
  return app.db
    .prepare("SELECT is_active, price_bdt, sms_quota FROM packages WHERE package_code = ?")
    .get(code) as { is_active: number; price_bdt: number; sms_quota: number } | undefined;
}

beforeEach(() => {
  app = buildApp({
    dbPath: join(mkdtempSync(join(tmpdir(), "dprelay-pkg-test-")), "test.db"),
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: OPERATOR,
      BKASH_PERSONAL_NUMBER: BKASH,
    },
  });
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, unixepoch())",
    )
    .run(crypto.randomUUID(), CRED["x-app-id"], sha256Hex(CRED["x-app-secret"]), "pkg-app");
});

afterEach(async () => {
  await app.close();
});

describe("PATCH /v5/admin/billing/packages/:code", () => {
  it("edits only the provided whitelisted fields", async () => {
    await op("POST", "/v5/admin/billing/packages", PKG);

    const res = await op("PATCH", "/v5/admin/billing/packages/otp100", { priceBdt: 250 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, packageCode: "otp100" });

    const row = packageRow("otp100");
    expect(row).toMatchObject({ price_bdt: 250, sms_quota: 100, is_active: 1 });

    const typeChange = await op("PATCH", "/v5/admin/billing/packages/otp100", { type: "both" });
    expect(typeChange.statusCode).toBe(200);
    const after = app.db
      .prepare("SELECT type, price_bdt FROM packages WHERE package_code = 'otp100'")
      .get() as { type: string; price_bdt: number };
    expect(after).toEqual({ type: "both", price_bdt: 250 });
  });

  it("validates fields, rejects empty patches, and 404s unknown codes", async () => {
    await op("POST", "/v5/admin/billing/packages", PKG);

    expect((await op("PATCH", "/v5/admin/billing/packages/otp100", { smsQuota: 0 })).statusCode).toBe(400);
    expect((await op("PATCH", "/v5/admin/billing/packages/otp100", { type: "sms" })).statusCode).toBe(400);
    expect((await op("PATCH", "/v5/admin/billing/packages/otp100", { priceBdt: -5 })).statusCode).toBe(400);
    const empty = await op("PATCH", "/v5/admin/billing/packages/otp100", {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: "invalid_package" });

    expect((await op("PATCH", "/v5/admin/billing/packages/nope", { priceBdt: 1 })).statusCode).toBe(404);
    expect((await op("PATCH", "/v5/admin/billing/packages/x", { priceBdt: 1 })).statusCode).toBe(400);

    const noAuth = await app.inject({
      method: "PATCH",
      url: "/v5/admin/billing/packages/otp100",
      payload: { priceBdt: 1 },
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it("keeps existing transactions on their request-time snapshot after an edit", async () => {
    const transactionId = await setupWithTransaction();
    const patched = await op("PATCH", "/v5/admin/billing/packages/otp100", { priceBdt: 999, smsQuota: 999 });
    expect(patched.statusCode).toBe(200);

    const queue = (await op("GET", "/v5/admin/billing/queue")).json() as {
      pending: { transactionId: string; amountBdt: number; smsQuota: number }[];
    };
    const row = queue.pending.find((t) => t.transactionId === transactionId);
    expect(row).toMatchObject({ amountBdt: 200, smsQuota: 100 });
  });
});

describe("DELETE /v5/admin/billing/packages/:code (RATIFIED safe-delete)", () => {
  it("hard-deletes a never-used package: row gone, catalog hides it, second delete 404s, gated", async () => {
    await op("POST", "/v5/admin/billing/packages", PKG);

    const res = await op("DELETE", "/v5/admin/billing/packages/otp100");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, packageCode: "otp100", deleted: true });

    // Zero references → the row is GONE (the ratified branch).
    expect(packageRow("otp100")).toBeUndefined();

    const catalog = (await app.inject({ method: "GET", url: "/v5/billing/packages" })).json() as {
      packages: { packageCode: string }[];
    };
    expect(catalog.packages.map((p) => p.packageCode)).not.toContain("otp100");

    // Second delete: unknown row now.
    const again = await op("DELETE", "/v5/admin/billing/packages/otp100");
    expect(again.statusCode).toBe(404);

    expect((await op("DELETE", "/v5/admin/billing/packages/nope")).statusCode).toBe(404);
    const noAuth = await app.inject({ method: "DELETE", url: "/v5/admin/billing/packages/otp100" });
    expect(noAuth.statusCode).toBe(401);
  });

  it("409s package_in_use when transactions reference it; retire endpoint still soft-retires", async () => {
    const transactionId = await setupWithTransaction();

    // Referenced → the RATIFIED branch: retire-only, forever.
    const res = await op("DELETE", "/v5/admin/billing/packages/otp100");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "package_in_use" });
    const row = packageRow("otp100");
    expect(row).toBeDefined();
    expect(row?.is_active).toBe(1);

    // The dedicated retire endpoint soft-retires the same referenced package.
    const retire = await op("POST", "/v5/admin/billing/packages/otp100/retire");
    expect(retire.statusCode).toBe(200);
    expect(packageRow("otp100")?.is_active).toBe(0);

    // Public catalog hides it; admin directory still lists it (reactivable).
    const catalog = (await app.inject({ method: "GET", url: "/v5/billing/packages" })).json() as {
      packages: { packageCode: string }[];
    };
    expect(catalog.packages.map((p) => p.packageCode)).not.toContain("otp100");
    const dir = (await op("GET", "/v5/admin/billing/packages")).json() as {
      packages: { packageCode: string; isActive: boolean }[];
    };
    expect(dir.packages.find((p) => p.packageCode === "otp100")?.isActive).toBe(false);

    // Reactivate via PATCH (the reverse of retire).
    const re = await op("PATCH", "/v5/admin/billing/packages/otp100", { isActive: true });
    expect(re.statusCode).toBe(200);
    const reRows = ((await op("GET", "/v5/admin/billing/packages")) as { json: () => unknown }).json() as {
      packages: { packageCode: string; isActive: boolean }[];
    };
    expect(reRows.packages.find((p) => p.packageCode === "otp100")?.isActive).toBe(true);
    expect(transactionId).toBeTruthy();
  });

  it("a retired (referenced) package's pending transaction still approves from the snapshot", async () => {
    const transactionId = await setupWithTransaction();

    // DELETE refuses (409), retire succeeds — history row stays intact.
    expect((await op("DELETE", "/v5/admin/billing/packages/otp100")).statusCode).toBe(409);
    const retire = await op("POST", "/v5/admin/billing/packages/otp100/retire");
    expect(retire.statusCode).toBe(200);
    expect(packageRow("otp100")).toBeDefined(); // history reference intact

    const approve = await op("POST", "/v5/admin/billing/approve", {
      transactionId,
      approve: true,
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ status: "approved", newOtpBalance: 100 });

    const trx = app.db
      .prepare("SELECT status, sms_quota FROM credit_transactions WHERE id = ?")
      .get(transactionId) as { status: string; sms_quota: number };
    expect(trx).toEqual({ status: "approved", sms_quota: 100 });
  });
});

describe("POST /v5/admin/billing/packages/:code/retire (ISSUE-84 spec endpoint)", () => {
  it("soft-retires regardless of references: row survives, catalog hides it, idempotent, gated", async () => {
    const up = await op("POST", "/v5/admin/billing/packages", PKG);
    expect(up.statusCode).toBe(201);

    const retire = await op("POST", "/v5/admin/billing/packages/otp100/retire");
    expect(retire.statusCode).toBe(200);
    expect(retire.json()).toMatchObject({ ok: true, packageCode: "otp100", isActive: false });
    expect(packageRow("otp100")?.is_active).toBe(0);

    // Row survives (soft retire) and the public catalog hides it.
    expect(packageRow("otp100")).toBeDefined();
    const catalog = (await app.inject({ method: "GET", url: "/v5/billing/packages" })).json() as {
      packages: unknown[];
    };
    expect(catalog.packages).toEqual([]);

    // Idempotent second retire; the admin directory still lists it as retired.
    const again = await op("POST", "/v5/admin/billing/packages/otp100/retire");
    expect(again.statusCode).toBe(200);
    const dir = (await op("GET", "/v5/admin/billing/packages")).json() as {
      packages: { packageCode: string; isActive: boolean }[];
    };
    expect(dir.packages.find((p) => p.packageCode === "otp100")?.isActive).toBe(false);

    // Unknown code 404s; operator gate holds.
    expect((await op("POST", "/v5/admin/billing/packages/nope/retire")).statusCode).toBe(404);
    const noAuth = await app.inject({ method: "POST", url: "/v5/admin/billing/packages/otp100/retire" });
    expect(noAuth.statusCode).toBe(401);
    expect((await op("POST", "/v5/admin/billing/packages/otp100/retire")).statusCode).toBe(200);

    // Safe-delete note: this retired row is still unreferenced, so DELETE
    // legitimately hard-deletes it (200 + row gone) — the ratified branch.
    expect((await op("DELETE", "/v5/admin/billing/packages/otp100")).statusCode).toBe(200);
    expect(packageRow("otp100")).toBeUndefined();
  });
});
