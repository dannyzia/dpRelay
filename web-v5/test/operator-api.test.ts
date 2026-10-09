import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePayment,
  attachPayment,
  clearOperatorSecret,
  downloadOperatorCsv,
  getAdminConfig,
  getLedgerReport,
  getOperatorSecret,
  getSendLog,
  listAdminPackages,
  listAdminUsers,
  listPayments,
  listPendingTransactions,
  operatorFetch,
  patchAdminPackage,
  putAdminConfig,
  rejectPayment,
  resolveTransaction,
  retireAdminPackage,
  setAdminUserDisabled,
  setOperatorRejectedHandler,
  setOperatorSecret,
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

  it("listPayments parses the new config shape + payment status/reason, forwarding filters", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({
        ok: true,
        config: { windowMin: 30, windowSec: 1800, toleranceBdt: 0 },
        payments: [
          {
            id: "p1",
            sender: "+8801613000000",
            provider: "bkash",
            txnId: "TRXAAA1111",
            amountBdt: 200,
            receivedAt: 1791400000,
            createdAt: 1791400000,
            status: "rejected",
            reason: "wrong sender",
            matched: null,
            candidates: [],
            ambiguous: false,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await listPayments({ status: "rejected", from: 100, to: 200 });
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/payments?status=rejected&from=100&to=200");
    expect(res.config).toMatchObject({ windowMin: 30, windowSec: 1800, toleranceBdt: 0 });
    expect(res.payments[0]).toMatchObject({ txnId: "TRXAAA1111", status: "rejected", reason: "wrong sender" });

    // No filters → bare path (no dangling query string).
    await listPayments();
    expect(fetchMock.mock.calls[1][0]).toBe("/v5/admin/payments");
  });

  it("getAdminConfig GETs and putAdminConfig PUTs { value } on the whitelisted key path", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, key: "payment_match_window_min", value: 45, updatedAt: 7 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await getAdminConfig("payment_match_window_min");
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/config/payment_match_window_min");
    expect(cfg).toMatchObject({ key: "payment_match_window_min", value: 45, updatedAt: 7 });

    const saved = await putAdminConfig("payment_match_window_min", 45);
    expect(fetchMock.mock.calls[1][0]).toBe("/v5/admin/config/payment_match_window_min");
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ value: 45 });
    expect(saved.value).toBe(45);
  });

  it("approvePayment posts bodylessly; rejectPayment carries the required reason", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, transactionId: "txn-1", status: "approved", newOtpBalance: 200, newBulkBalance: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const approved = await approvePayment("payment-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/payments/payment-1/approve");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(approved.newOtpBalance).toBe(200);

    const fetchMock2 = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, status: "rejected", reason: "duplicate" }),
    );
    vi.stubGlobal("fetch", fetchMock2);
    const rejected = await rejectPayment("payment-1", "duplicate");
    expect(fetchMock2.mock.calls[0][0]).toBe("/v5/admin/payments/payment-1/reject");
    const init = fetchMock2.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "duplicate" });
    expect(rejected).toMatchObject({ status: "rejected", reason: "duplicate" });
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
    expect(fetchMock.mock.calls[2][0]).toBe("/v5/admin/billing/packages/otp100/retire");
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("POST");
  });

  it("user withhold toggles hit disable (with reason body) / enable with POST", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonRes({ ok: true, users: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const users = await listAdminUsers();
    expect(users).toEqual([]);

    await setAdminUserDisabled("user-1", true, "chargeback investigation");
    expect(fetchMock.mock.calls[1][0]).toBe("/v5/admin/users/user-1/disable");
    const disableInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(disableInit.method).toBe("POST");
    expect(JSON.parse(disableInit.body as string)).toEqual({ reason: "chargeback investigation" });

    await setAdminUserDisabled("user-1", false);
    expect(fetchMock.mock.calls[2][0]).toBe("/v5/admin/users/user-1/enable");
    expect((fetchMock.mock.calls[2][1] as RequestInit).body).toBeUndefined();
  });

  it("getSendLog hits the spec /sends path with filters and parses rows + cursor", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({ ok: true, rows: [], nextCursor: "1791400000:m1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getSendLog({ from: 100, to: 200, appId: "app_x" });
    expect(res.rows).toEqual([]);
    expect(res.nextCursor).toBe("1791400000:m1");
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/admin/reports/sends?appId=app_x&from=100&to=200");

    await getSendLog({ cursor: "1791400000:m1" });
    expect(fetchMock.mock.calls[1][0]).toBe("/v5/admin/reports/sends?cursor=1791400000%3Am1");
  });

  it("getLedgerReport forwards appId/window/cursor and parses the new report shape", async () => {
    setOperatorSecret("op-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonRes({
        ok: true,
        from: 1,
        to: 2,
        rows: [
          {
            id: "row-1",
            timestamp: 1791400000,
            appId: "app_owned",
            appName: "Owned",
            ownerEmail: "c@example.test",
            kind: "purchase",
            packageCode: "otp100",
            qty: 100,
            amountBdt: 200,
            trxId: null,
          },
        ],
        nextCursor: "1791400000:row-1",
        totals: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getLedgerReport({ appId: "app_owned", from: 1, to: 2, cursor: "c:1" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/v5/admin/reports/ledger?appId=app_owned&from=1&to=2&cursor=c%3A1",
    );
    expect(res.rows[0]).toMatchObject({ kind: "purchase", qty: 100, amountBdt: 200 });
    expect(res.nextCursor).toBe("1791400000:row-1");
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
