import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachPayment,
  clearOperatorSecret,
  downloadOperatorCsv,
  getOperatorSecret,
  getSendLog,
  listAdminPackages,
  listAdminUsers,
  listPayments,
  listPendingTransactions,
  operatorFetch,
  patchAdminPackage,
  resolveTransaction,
  retireAdminPackage,
  setAdminUserDisabled,
  setOperatorRejectedHandler,
  setOperatorSecret,
  updateMatchConfig,
} from "../src/api";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("operator credential storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips the per-session secret and clears it on lock", () => {
    expect(getOperatorSecret()).toBeNull();
    setOperatorSecret("op-secret");
    expect(getOperatorSecret()).toBe("op-secret");
    clearOperatorSecret();
    expect(getOperatorSecret()).toBeNull();
  });
});

describe("operatorFetch", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    setOperatorRejectedHandler(null);
  });

  it("sends Authorization: Bearer <OPERATOR_SECRET>", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, generatedAt: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await operatorFetch("/v5/admin/metrics");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer op-secret");
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/metrics");
  });

  it("fails fast with operator_not_configured when nothing is stored", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(operatorFetch("/v5/admin/metrics")).rejects.toMatchObject({
      code: "operator_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the secret and notifies the shell on a 401", async () => {
    setOperatorSecret("wrong-secret");
    const onRejected = vi.fn();
    setOperatorRejectedHandler(onRejected);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ ok: false, error: "Invalid operator secret", code: "invalid_operator_secret" }, 401),
      ),
    );

    await expect(operatorFetch("/v5/admin/billing/queue")).rejects.toMatchObject({
      status: 401,
      code: "invalid_operator_secret",
    });
    expect(getOperatorSecret()).toBeNull();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });
});

describe("operator endpoints", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    setOperatorRejectedHandler(null);
  });

  it("listPendingTransactions parses the queue envelope", async () => {
    setOperatorSecret("op-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({
          ok: true,
          pending: [
            {
              transactionId: "txn-9",
              appId: "customer-1",
              packageCode: "OTP-20",
              smsQuota: 20,
              amountBdt: 50,
              packageType: "otp",
              trxId: "TRX9",
              requestedAt: 1791400000,
            },
          ],
        }),
      ),
    );
    const rows = await listPendingTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transactionId: "txn-9", trxId: "TRX9", amountBdt: 50 });
  });

  it("resolveTransaction posts approve + rejectReason in the body", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, status: "rejected", newOtpBalance: 0, newBulkBalance: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await resolveTransaction("txn-9", false, "payment not found");
    expect(res.status).toBe("rejected");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      transactionId: "txn-9",
      approve: false,
      rejectReason: "payment not found",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer op-secret");
  });

  it("resolveTransaction omits rejectReason on approve", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, status: "approved", newOtpBalance: 70, newBulkBalance: 50 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await resolveTransaction("txn-9", true);
    expect(res.newOtpBalance).toBe(70);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      transactionId: "txn-9",
      approve: true,
    });
  });
});

describe("F5 admin endpoints", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    setOperatorRejectedHandler(null);
  });

  it("listPayments parses config + payment items", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({
        ok: true,
        config: { toleranceBdt: 100, windowSec: 604800 },
        payments: [
          {
            id: "p1",
            sender: "+8801613000000",
            provider: "bkash",
            txnId: "TRXAAA1111",
            amountBdt: 200,
            receivedAt: 1791400000,
            createdAt: 1791400000,
            matched: null,
            candidates: [],
            ambiguous: false,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await listPayments();
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/payments");
    expect(res.config).toMatchObject({ toleranceBdt: 100, windowSec: 604800 });
    expect(res.payments[0]).toMatchObject({ txnId: "TRXAAA1111", matched: null });
  });

  it("updateMatchConfig PUTs only the provided tunable fields", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, toleranceBdt: 250, windowSec: 86400, updatedAt: 5 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await updateMatchConfig({ toleranceBdt: 250, windowSec: 86400 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ toleranceBdt: 250, windowSec: 86400 });
    expect(cfg).toMatchObject({ toleranceBdt: 250, windowSec: 86400 });
  });

  it("attachPayment posts the explicit transactionId (the operator's ambiguity resolution)", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, transactionId: "txn-1", status: "approved", newOtpBalance: 200, newBulkBalance: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await attachPayment("payment-1", "txn-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/payments/payment-1/attach");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ transactionId: "txn-1" });
    expect(res.newOtpBalance).toBe(200);
  });

  it("package CRUD routes: list, PATCH partial, DELETE retire", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonRes({ ok: true, packages: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listAdminPackages();
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/billing/packages");

    await patchAdminPackage("otp100", { priceBdt: 250 });
    const patchInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(patchInit.method).toBe("PATCH");
    expect(fetchMock.mock.calls[1][0]).toBe("/v5/admin/billing/packages/otp100");
    expect(JSON.parse(patchInit.body as string)).toEqual({ priceBdt: 250 });

    await retireAdminPackage("otp100");
    expect(fetchMock.mock.calls[2][0]).toBe("/v5/admin/billing/packages/otp100");
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });

  it("user withhold toggles hit disable/enable with POST", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonRes({ ok: true, users: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const users = await listAdminUsers();
    expect(users).toEqual([]);

    await setAdminUserDisabled("user-1", true);
    expect(fetchMock.mock.calls[1][0]).toBe("/v5/admin/users/user-1/disable");
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");

    await setAdminUserDisabled("user-1", false);
    expect(fetchMock.mock.calls[2][0]).toBe("/v5/admin/users/user-1/enable");
  });

  it("getSendLog forwards the appId filter and window", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonRes({ ok: true, rows: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await getSendLog({ from: 100, to: 200, appId: "app_x" });
    expect(rows).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/reports/send-log?from=100&to=200&appId=app_x");
  });

  it("downloadOperatorCsv fetches the CSV export with the operator secret and hands it to a blob URL", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response("createdAt,recipient\r\n'2026-01-01T00:00:00.000Z,'+880171\r\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Node test environment: no DOM and no URL.createObjectURL — stub both.
    const createObjectURL = vi.fn(() => "blob:csv-test");
    const revokeObjectURL = vi.fn();
    const urlBackup = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const fakeAnchor = { href: "", download: "", click, remove };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => fakeAnchor),
      body: { appendChild },
    });

    try {
      await downloadOperatorCsv("/v5/admin/reports/send-log?format=csv", "send-log.csv");
      expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/reports/send-log?format=csv");
      const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer op-secret");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv-test");
      expect(appendChild).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(fakeAnchor.download).toBe("send-log.csv");
    } finally {
      Object.assign(URL, urlBackup);
      vi.unstubAllGlobals();
    }
  });
});
