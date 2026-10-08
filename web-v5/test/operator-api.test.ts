import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOperatorSecret,
  getOperatorSecret,
  listPendingTransactions,
  operatorFetch,
  resolveTransaction,
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
