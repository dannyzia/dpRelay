/**
 * F5 amendments (ISSUE-89, hub events 1318/1319/1320):
 * - packages.currency enum BDT|USD|EUR (migration 018): create/edit/list/
 *   public-catalog surfaces + the database CHECK invariant;
 * - the package-aggregate report (GET /v5/admin/reports/packages) — per
 *   package count sold + totals, currency-dimensioned (never summed across
 *   currencies), approved-only, window-bounded;
 * - currency-aware payment matching: USD/EUR packages are NEVER auto-matched
 *   (remittance-rail purchases are bKash BDT-equivalents — manual operator
 *   approval with a remittance reference note, by design);
 * - pricing-conformance judges BDT rows only (0.20 BDT unit price).
 *
 * Uses temp DBs + app.inject — no real network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "f5c-test-jwt-0123456789abcdef0123456789abcdef";
const OPERATOR = "f5c-operator-secret-0123456789abcdef";
const BKASH = "+8801711000000";

const CRED = {
  "x-app-id": "app_f5c",
  "x-app-secret": "secret-f5c-0123456789abcdef0123456789abcdef",
};

let app: FastifyInstance;

function op(method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${OPERATOR}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Inserts an ingested payment-SMS row directly (ingest itself is device-plane tested). */
function seedPayment(txnId: string, paisa: number, receivedAt: number): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO payment_sms (id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at) " +
        "VALUES (?, NULL, '+8801613000000', 'bkash', ?, ?, ?, unixepoch())",
    )
    .run(id, txnId, paisa, receivedAt);
  return id;
}

/** Creates a package via the operator route. */
async function createPackage(opts: {
  packageCode: string;
  priceBdt: number;
  currency?: string;
  smsQuota?: number;
}): Promise<void> {
  const res = await op("POST", "/v5/admin/billing/packages", {
    packageCode: opts.packageCode,
    name: opts.packageCode,
    smsQuota: opts.smsQuota ?? 100,
    priceBdt: opts.priceBdt,
    validityDays: 30,
    type: "otp",
    ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
  });
  expect(res.statusCode).toBe(201);
}

/** App-plane purchase request → pending transactionId. */
async function requestPurchase(packageCode: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v5/billing/credits/request",
    headers: CRED,
    payload: { packageCode },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { transactionId: string }).transactionId;
}

/** Operator approve (optionally with a remittance note). */
async function approve(transactionId: string, notes?: string) {
  return op("POST", "/v5/admin/billing/approve", {
    transactionId,
    approve: true,
    ...(notes !== undefined ? { notes } : {}),
  });
}

beforeEach(() => {
  app = buildApp({
    dbPath: join(testTmpDir("dprelay-f5c-test-"), "test.db"),
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
    .run(crypto.randomUUID(), CRED["x-app-id"], sha256Hex(CRED["x-app-secret"]), "f5c-app");
});

afterEach(async () => {
  await app.close();
});

describe("packages.currency (ISSUE-89)", () => {
  it("creates, edits and serves currency across admin + public surfaces (default BDT)", async () => {
    await createPackage({ packageCode: "otp-bdt", priceBdt: 200 });
    await createPackage({ packageCode: "otp-usd", priceBdt: 20, currency: "USD" });

    const admin = (await op("GET", "/v5/admin/billing/packages")).json() as {
      packages: { packageCode: string; currency: string }[];
    };
    expect(admin.packages.find((p) => p.packageCode === "otp-bdt")?.currency).toBe("BDT");
    expect(admin.packages.find((p) => p.packageCode === "otp-usd")?.currency).toBe("USD");

    const catalog = (await app.inject({ method: "GET", url: "/v5/billing/packages" })).json() as {
      packages: { packageCode: string; currency: string }[];
    };
    expect(catalog.packages.find((p) => p.packageCode === "otp-usd")?.currency).toBe("USD");

    // Edit: currency is a whitelisted PATCH field.
    const patched = await op("PATCH", "/v5/admin/billing/packages/otp-usd", { currency: "EUR" });
    expect(patched.statusCode).toBe(200);
    const row = app.db
      .prepare("SELECT currency FROM packages WHERE package_code = 'otp-usd'")
      .get() as { currency: string };
    expect(row.currency).toBe("EUR");

    // Validation: enum enforced on both routes; the DB CHECK backs it up.
    expect((await createPackageRejecting("otp-bad", "GBP"))).toBe(400);
    // PATCH validates the BODY before row existence — an unknown code with a
    // bad currency 400s first (valid-currency unknown codes still 404;
    // package-crud pins that, so no enumeration vector either way).
    const patchBad = await op("PATCH", "/v5/admin/billing/packages/otp-bad", { currency: "GBP" });
    expect(patchBad.statusCode).toBe(400);
    const patchBad2 = await op("PATCH", "/v5/admin/billing/packages/otp-bdt", { currency: "GBP" });
    expect(patchBad2.statusCode).toBe(400);
    expect(patchBad2.json()).toMatchObject({ code: "invalid_package" });
    expect(() =>
      app.db
        .prepare(
          "INSERT INTO packages (id, package_code, name, sms_quota, price_bdt, validity_days, type, is_active, currency, created_at, updated_at) " +
            "VALUES ('x', 'direct-bad', 'x', 1, 1, 1, 'otp', 1, 'GBP', unixepoch(), unixepoch())",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  /** Helper: attempts a create that must 400 on currency. */
  async function createPackageRejecting(packageCode: string, currency: string): Promise<number> {
    const res = await op("POST", "/v5/admin/billing/packages", {
      packageCode,
      name: packageCode,
      smsQuota: 100,
      priceBdt: 100,
      validityDays: 30,
      type: "otp",
      currency,
    });
    return res.statusCode;
  }

  it("pricing-conformance judges BDT rows only and reports the excluded non-BDT count", async () => {
    // 100 SMS × 0.20 BDT = 20 — the BDT package mismatches at 999 (violation),
    // the USD package's 999 is a regional price, not a violation.
    await createPackage({ packageCode: "bdt-wrong", priceBdt: 999, currency: "BDT" });
    await createPackage({ packageCode: "usd-fine", priceBdt: 999, currency: "USD" });

    const report = (await op("GET", "/v5/admin/billing/pricing-conformance")).json() as {
      packageCount: number;
      excludedNonBdtCount: number;
      violationCount: number;
      violations: { packageCode: string }[];
    };
    expect(report.packageCount).toBe(2);
    expect(report.excludedNonBdtCount).toBe(1);
    expect(report.violationCount).toBe(1);
    expect(report.violations.map((v) => v.packageCode)).toEqual(["bdt-wrong"]);
  });
});

describe("package-aggregate report (ISSUE-89, hub event 1318)", () => {
  it("groups approved sales per package, totals per currency, window-bounded, pending excluded", async () => {
    await createPackage({ packageCode: "bdt-pack", priceBdt: 200, smsQuota: 100 });
    await createPackage({ packageCode: "usd-pack", priceBdt: 20, currency: "USD", smsQuota: 50 });

    // 2 approved BDT sales + 1 approved USD sale + 1 still-pending BDT sale.
    const t1 = await requestPurchase("bdt-pack");
    const t2 = await requestPurchase("bdt-pack");
    const t3 = await requestPurchase("usd-pack");
    const pending = await requestPurchase("bdt-pack");
    expect((await approve(t1)).statusCode).toBe(200);
    expect((await approve(t2)).statusCode).toBe(200);
    expect((await approve(t3)).statusCode).toBe(200);

    const report = (await op("GET", "/v5/admin/reports/packages")).json() as {
      from: number;
      to: number;
      rows: {
        packageCode: string;
        currency: string;
        countSold: number;
        totalAmount: number;
        smsSold: number;
      }[];
      totalsByCurrency: { currency: string; countSold: number; totalAmount: number }[];
    };

    const bdt = report.rows.find((r) => r.packageCode === "bdt-pack");
    expect(bdt).toMatchObject({ currency: "BDT", countSold: 2, totalAmount: 400, smsSold: 200 });
    const usd = report.rows.find((r) => r.packageCode === "usd-pack");
    expect(usd).toMatchObject({ currency: "USD", countSold: 1, totalAmount: 20, smsSold: 50 });

    // Currency dimension: rollups never mix units; pending sale not counted.
    expect(report.totalsByCurrency).toEqual([
      { currency: "BDT", countSold: 2, totalAmount: 400 },
      { currency: "USD", countSold: 1, totalAmount: 20 },
    ]);
    expect(report.rows.find((r) => r.packageCode === "bdt-pack")?.countSold).toBe(2);
    expect(pending).toBeTruthy();

    // Window: a future range excludes everything.
    const now = Math.floor(Date.now() / 1000);
    const empty = (await op(
      "GET",
      `/v5/admin/reports/packages?from=${now + 90000}&to=${now + 91000}`,
    )).json() as { rows: unknown[]; totalsByCurrency: unknown[] };
    expect(empty.rows).toEqual([]);
    expect(empty.totalsByCurrency).toEqual([]);

    // Operator gate.
    const noAuth = await app.inject({ method: "GET", url: "/v5/admin/reports/packages" });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe("currency-aware payment approval (ISSUE-89, hub event 1320)", () => {
  it("never auto-matches a USD package; BDT control still proposes — manual approve stores the note", async () => {
    const now = Math.floor(Date.now() / 1000);
    await createPackage({ packageCode: "usd-pack", priceBdt: 20, currency: "USD" });
    await createPackage({ packageCode: "bdt-pack", priceBdt: 200, smsQuota: 100 });

    // Identical economics: same amount (20.00), same instant — the ONLY
    // difference between the two transactions is the package currency.
    const usdTrx = await requestPurchase("usd-pack"); // amount 20 USD
    const bdtTrx = await requestPurchase("bdt-pack"); // amount 200 BDT — differs, so ALSO seed one BDT at 20
    // Make a BDT package purchase whose amount equals the payment too:
    await createPackage({ packageCode: "bdt-20", priceBdt: 20, smsQuota: 100 });
    const bdt20Trx = await requestPurchase("bdt-20");
    expect(bdtTrx).toBeTruthy();

    seedPayment("TRX-F5C-1", 2000, now); // 20.00 BDT, received now
    seedPayment("TRX-F5C-2", 2000, now - 60);

    const list = (await op("GET", "/v5/admin/payments")).json() as {
      payments: {
        txnId: string;
        status: string;
        candidates: { transactionId: string; packageCode: string }[];
        ambiguous: boolean;
      }[];
    };
    const p1 = list.payments.find((p) => p.txnId === "TRX-F5C-1");
    const p2 = list.payments.find((p) => p.txnId === "TRX-F5C-2");

    // USD candidate is INVISIBLE to auto-match; the BDT-20 control proposes.
    const candidateIds1 = (p1?.candidates ?? []).map((c) => c.transactionId);
    const candidateIds2 = (p2?.candidates ?? []).map((c) => c.transactionId);
    expect(candidateIds1).not.toContain(usdTrx);
    expect(candidateIds2).toContain(bdt20Trx);
    expect(p2?.status).toBe("matched");
    expect(p2?.ambiguous).toBe(false);

    // Auto-approve refuses: no candidates for the payment matching the USD trx.
    // (TRX-F5C-1 may see the BDT-20 candidate — assert the USD trx can never
    // be auto-attached through either path.)
    const rows = list.payments.map((p) => p.candidates.map((c) => c.transactionId)).flat();
    expect(rows).not.toContain(usdTrx);

    // Manual approval path: operator approves the USD transaction directly,
    // attaching the remittance reference note (the paper trail by design).
    const manual = await approve(usdTrx, "Remittance ref RMT-9981 (Wise)");
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ status: "approved" });
    const row = app.db
      .prepare("SELECT status, admin_notes FROM credit_transactions WHERE id = ?")
      .get(usdTrx) as { status: string; admin_notes: string | null };
    expect(row.status).toBe("approved");
    expect(row.admin_notes).toBe("Remittance ref RMT-9981 (Wise)");
  });
});
