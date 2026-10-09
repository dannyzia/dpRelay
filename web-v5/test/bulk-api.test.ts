/**
 * F5c (ISSUE-85) — bulk API client: preview goes out as raw text/csv with the
 * app credential headers, and the two-step create carries the checksum in its
 * JSON confirm payload; envelope failures surface their server codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectApp,
  createBulkCampaign,
  previewBulkCsv,
  setAppUnauthorizedHandler,
} from "../src/api";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("bulk preview + two-step create (F5c)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    connectApp("bulk_app", "bulk-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setAppUnauthorizedHandler(null);
  });

  it("previewBulkCsv posts the raw csv as text/csv with the app credential headers", async () => {
    const fetchMock = vi.fn(async () =>
      jsonRes({
        ok: true,
        total: 1,
        sampleFirst5: ["+8801711000001"],
        invalidRows: [],
        checksum: "abc123",
        headerSkipped: true,
        perCampaignLimit: 10_000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const csv = "phone\n+8801711000001\n";
    const preview = await previewBulkCsv(csv);
    expect(preview).toMatchObject({
      total: 1,
      sampleFirst5: ["+8801711000001"],
      checksum: "abc123",
      headerSkipped: true,
      perCampaignLimit: 10_000,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v5/bulk/campaigns/preview");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/csv");
    expect(headers["X-App-Id"]).toBe("bulk_app");
    expect(headers["X-App-Secret"]).toBe("bulk-secret");
    expect(init.body).toBe(csv);
  });

  it("preview surfaces the server's envelope code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(
          { ok: false, error: "Recipient file exceeds 5242880 bytes", code: "file_too_large" },
          413,
        ),
      ),
    );
    await expect(previewBulkCsv("x".repeat(10))).rejects.toMatchObject({
      code: "file_too_large",
      status: 413,
    });
  });

  it("createBulkCampaign posts {checksum, name, message, csv} as JSON", async () => {
    const fetchMock = vi.fn(async () =>
      jsonRes({
        ok: true,
        campaignId: "camp-1",
        totalRecipients: 2,
        creditsReserved: 2,
        charset: "gsm",
        status: "queued",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createBulkCampaign({
      checksum: "deadbeef",
      name: "Promo",
      message: "Hi there",
      csv: "+8801711000001\n",
    });
    expect(result).toMatchObject({ campaignId: "camp-1", totalRecipients: 2, creditsReserved: 2 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v5/bulk/campaigns");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      checksum: "deadbeef",
      name: "Promo",
      message: "Hi there",
      csv: "+8801711000001\n",
      sourceType: "csv",
    });
  });

  it("create rejects checksum_mismatch with the server's code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(
          {
            ok: false,
            error: "Recipient list changed since preview — run preview again",
            code: "checksum_mismatch",
          },
          400,
        ),
      ),
    );
    await expect(
      createBulkCampaign({ checksum: "stale", name: "n", message: "m", csv: "c" }),
    ).rejects.toMatchObject({ code: "checksum_mismatch", status: 400 });
  });
});
