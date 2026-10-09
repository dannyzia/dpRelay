/**
 * F5c (ISSUE-85) — bulk recipient upload two-step: preview → checksum-bound
 * confirm. Covers the acceptance criteria: valid CSV preview, malformed rows
 * reported with line numbers (never dropped), 5 MB / 50 000-row caps,
 * checksum_required / checksum_mismatch rejections that spend nothing,
 * quota-exceeding → 402, and per-app campaign isolation.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { sha256Hex } from "../src/services/crypto.js";

const TEST_JWT_SECRET = "bulk-preview-jwt-0123456789abcdef0123456789abcdef";
const TEST_ENROLLMENT_SECRET = "enroll-only-secret-0123456789abcdef0123456789ab";

function makeApp(extra: Record<string, string> = {}): FastifyInstance {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-bulk-preview-test-")), "test.db");
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      DEVICE_ENROLLMENT_SECRET: TEST_ENROLLMENT_SECRET,
      BULK_ENABLED: "true",
      ...extra,
    },
  });
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

/** Inserts an app row directly; returns the internal id (credits/app FK key). */
function seedApp(appId: string, appSecret: string): string {
  const id = crypto.randomUUID();
  app.db
    .prepare(
      "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, " +
        "rate_max_per_phone, rate_window_sec, created_at) VALUES (?, ?, ?, 'Preview App', NULL, NULL, 3, 3600, unixepoch())",
    )
    .run(id, appId, sha256Hex(appSecret));
  return id;
}

function seedCredits(appRowId: string, bulk: number): void {
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, bulk_sms_remaining, bulk_expires_at, updated_at) VALUES (?, ?, NULL, unixepoch())",
    )
    .run(appRowId, bulk);
}

const CREDS = (appId: string, secret: string) => ({
  "x-app-id": appId,
  "x-app-secret": secret,
});

const SECRET_A = "bulk-preview-secret-a-0123456789abcdef0123456789ab";
const SECRET_B = "bulk-preview-secret-b-0123456789abcdef0123456789ab";
const PHONES = ["+8801711000001", "+8801711000002", "+8801711000003"];

function credentials(withCredits = true, bulk = 100): Record<string, string> {
  app = makeApp();
  const appRowId = seedApp("bulk_app", SECRET_A);
  if (withCredits) seedCredits(appRowId, bulk);
  return CREDS("bulk_app", SECRET_A);
}

interface PreviewBody {
  ok: boolean;
  total: number;
  sampleFirst5: string[];
  invalidRows: { line: number; reason: string }[];
  checksum: string;
  headerSkipped?: boolean;
  perCampaignLimit?: number;
  code?: string;
}

async function previewCsv(creds: Record<string, string>, csv: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v5/bulk/campaigns/preview",
    headers: { ...creds, "content-type": "text/csv" },
    payload: csv,
  });
  return { statusCode: res.statusCode, body: res.json() as PreviewBody };
}

async function previewRows(creds: Record<string, string>, phones: string[]) {
  const res = await app.inject({
    method: "POST",
    url: "/v5/bulk/campaigns/preview",
    headers: creds,
    payload: { phones },
  });
  return { statusCode: res.statusCode, body: res.json() as PreviewBody };
}

function campaignCount(): number {
  return (app.db.prepare("SELECT COUNT(*) AS n FROM bulk_campaigns").get() as { n: number }).n;
}

describe("POST /v5/bulk/campaigns/preview", () => {
  it("parses a header CSV: count + first 5 + deterministic checksum, no spend", async () => {
    const creds = credentials();
    const csv = ["phone,note", "+8801711000001,a", "+8801711000002,b", "+8801711000003,c", ""].join("\n");
    const { statusCode, body } = await previewCsv(creds, csv);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      total: 3,
      sampleFirst5: PHONES,
      invalidRows: [],
      headerSkipped: true,
      perCampaignLimit: 10_000,
    });
    expect(body.checksum).toBe(sha256Hex(PHONES.join("\n")));
    // Preview must never spend or create anything.
    expect(campaignCount()).toBe(0);
    const credits = app.db
      .prepare("SELECT bulk_sms_remaining FROM app_credits WHERE app_id = (SELECT id FROM apps LIMIT 1)")
      .get() as { bulk_sms_remaining: number };
    expect(credits.bulk_sms_remaining).toBe(100);
  });

  it("reports malformed rows with file line numbers and excludes them from the total", async () => {
    const creds = credentials();
    const csv = [
      "phone", // line 1: header
      "+8801711000001", // line 2: valid
      "abc", // line 3: invalid
      "", // line 4: blank, skipped
      "+880", // line 5: invalid
      "+8801711000002", // line 6: valid
      '"not-a-phone"', // line 7: invalid (quoted)
    ].join("\r\n");
    const { statusCode, body } = await previewCsv(creds, csv);
    expect(statusCode).toBe(200);
    expect(body.total).toBe(2);
    expect(body.sampleFirst5).toEqual(["+8801711000001", "+8801711000002"]);
    expect(body.invalidRows.map((r) => r.line)).toEqual([3, 5, 7]);
    for (const row of body.invalidRows) expect(row.reason).toBeTruthy();
    expect(body.checksum).toBe(sha256Hex("+8801711000001\n+8801711000002"));
  });

  it("yields the same checksum for JSON rows and the equivalent CSV", async () => {
    const creds = credentials();
    const fromCsv = await previewCsv(creds, "+8801711000001\n+8801711000002\n");
    const fromRows = await previewRows(creds, PHONES.slice(0, 2));
    expect(fromCsv.body.checksum).toBe(fromRows.body.checksum);
  });

  it("rejects a file over the 50 000-row cap", async () => {
    const creds = credentials();
    const csv = "+8801711000001\n".repeat(50_001);
    const { statusCode, body } = await previewCsv(creds, csv);
    expect(statusCode).toBe(400);
    expect(body.code).toBe("too_many_rows");
  });

  it("rejects a file over the 5 MB cap", async () => {
    const creds = credentials();
    const { statusCode, body } = await previewCsv(creds, "x".repeat(5 * 1024 * 1024 + 1));
    expect(statusCode).toBe(413);
    expect(body.code).toBe("file_too_large");
  });

  it("honours the bulk feature flag", async () => {
    app = makeApp({ BULK_ENABLED: "false" });
    const appRowId = seedApp("bulk_app", SECRET_A);
    seedCredits(appRowId, 100);
    const { statusCode, body } = await previewCsv(CREDS("bulk_app", SECRET_A), "+8801711000001\n");
    expect(statusCode).toBe(403);
    expect(body.code).toBe("bulk_not_enabled");
  });
});

describe("POST /v5/bulk/campaigns — two-step checksum binding", () => {
  it("rejects a csv create without a checksum and spends nothing", async () => {
    const creds = credentials();
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: creds,
      payload: { campaignName: "No preview", message: "Hello from dP Relay", phones: PHONES },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("checksum_required");
    expect(campaignCount()).toBe(0);
  });

  it("rejects a checksum that does not match the submitted list, spending nothing", async () => {
    const creds = credentials();
    const preview = await previewRows(creds, PHONES);
    expect(preview.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: creds,
      payload: {
        campaignName: "Tampered",
        message: "Hello from dP Relay",
        phones: [PHONES[0], PHONES[1], "+8801711000099"],
        checksum: preview.body.checksum,
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("checksum_mismatch");
    expect(campaignCount()).toBe(0);
  });

  it("accepts preview → confirm (AC payload: {checksum, name, message, csv}) and spends exactly once", async () => {
    const creds = credentials();
    const csv = PHONES.join("\n") + "\n";
    const preview = await previewCsv(creds, csv);
    expect(preview.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: creds,
      payload: {
        checksum: preview.body.checksum,
        name: "Promo blast",
        message: "Hello from dP Relay",
        csv,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { totalRecipients: number; creditsReserved: number };
    expect(body.totalRecipients).toBe(3);
    expect(body.creditsReserved).toBe(3);
    const credits = app.db
      .prepare("SELECT bulk_sms_remaining FROM app_credits WHERE app_id = (SELECT id FROM apps LIMIT 1)")
      .get() as { bulk_sms_remaining: number };
    expect(credits.bulk_sms_remaining).toBe(97);
    expect(campaignCount()).toBe(1);
  });

  it("rejects when the file changed between preview and submit", async () => {
    const creds = credentials();
    const preview = await previewCsv(creds, PHONES.join("\n") + "\n");
    const edited = [PHONES[0], PHONES[1], "+8801711000088"].join("\n") + "\n";
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: creds,
      payload: {
        campaignName: "Edited file",
        message: "Hello from dP Relay",
        csv: edited,
        checksum: preview.body.checksum,
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("checksum_mismatch");
    expect(campaignCount()).toBe(0);
  });

  it("rejects malformed csv rows on submit with line numbers", async () => {
    const creds = credentials();
    const csv = "phone\n+8801711000001\nnope\n";
    const preview = await previewCsv(creds, csv);
    expect(preview.body.invalidRows).toEqual([
      { line: 3, reason: expect.stringContaining("E.164") },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: creds,
      payload: {
        campaignName: "Bad rows",
        message: "Hello from dP Relay",
        csv,
        checksum: preview.body.checksum,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; invalidRows: { line: number }[] };
    expect(body.code).toBe("invalid_phones");
    expect(body.invalidRows.map((r) => r.line)).toEqual([3]);
    expect(campaignCount()).toBe(0);
  });

  it("returns 402 when credits cannot cover the list, creating nothing", async () => {
    const creds = credentials(true, 1);
    const preview = await previewRows(creds, PHONES);
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: creds,
      payload: {
        campaignName: "Too rich",
        message: "Hello from dP Relay",
        phones: PHONES,
        checksum: preview.body.checksum,
      },
    });
    expect(res.statusCode).toBe(402);
    expect((res.json() as { code: string }).code).toBe("insufficient_bulk_credits");
    expect(campaignCount()).toBe(0);
  });

  it("keeps campaigns isolated between apps", async () => {
    const credsA = credentials();
    const appRowB = seedApp("bulk_app_b", SECRET_B);
    seedCredits(appRowB, 100);
    const csv = PHONES.join("\n") + "\n";
    const preview = await previewCsv(credsA, csv);
    const res = await app.inject({
      method: "POST",
      url: "/v5/bulk/campaigns",
      headers: credsA,
      payload: { campaignName: "Mine", message: "Hello from dP Relay", csv, checksum: preview.body.checksum },
    });
    expect(res.statusCode).toBe(201);

    const listB = await app.inject({
      method: "GET",
      url: "/v5/bulk/campaigns",
      headers: CREDS("bulk_app_b", SECRET_B),
    });
    const bodyB = listB.json() as { campaigns: unknown[] };
    expect(bodyB.campaigns).toEqual([]);
  });
});
