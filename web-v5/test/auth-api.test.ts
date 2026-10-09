/**
 * STAGE F3 (ISSUE-81): customer-auth API client tests — the /v5/auth/*
 * wrappers, the signed-out-as-null contract of getCurrentUser, and the
 * credentialed-fetch guarantee that carries the HttpOnly session cookie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createCompany,
  createSelfServeApp,
  disableCompany,
  forgotPassword,
  getCurrentUser,
  getMailStatus,
  getWallet,
  getWalletTransactions,
  linkOwnedApp,
  listCompanies,
  listOwnedApps,
  loginAccount,
  logoutAccount,
  registerAccount,
  renameCompany,
  request,
  requestWalletCredits,
  resendVerification,
  resetPassword,
  submitWalletTrx,
  verifyEmail,
} from "../src/api";

/** JSON Response helper for the fetch mock. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("customer auth API (F3)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("register/login/logout hit the ordered routes with the ordered bodies", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }, 201));
    await registerAccount("a@example.com", "correct-horse-battery");
    expect(fetchMock.mock.calls[0][0]).toContain("/v5/auth/register");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      email: "a@example.com",
      password: "correct-horse-battery",
    });

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, accessToken: "at", refreshToken: "rt" }));
    await loginAccount("a@example.com", "correct-horse-battery");
    expect(fetchMock.mock.calls[1][0]).toContain("/v5/auth/login");

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await logoutAccount();
    expect(fetchMock.mock.calls[2][0]).toContain("/v5/auth/logout");
    expect(fetchMock.mock.calls[2][1].method).toBe("POST");
  });

  it("sends every request with credentials:include so the session cookie travels", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, user: { id: "u1", email: "a@b.c", createdAt: 1 } }));
    await request("/v5/auth/me", { method: "GET" });
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });

  it("getCurrentUser maps 401 auth_required to null (signed out), not an error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ ok: false, error: "Sign in required", code: "auth_required" }, 401),
    );
    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("getCurrentUser propagates real failures (network) instead of swallowing them", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(getCurrentUser()).rejects.toBeInstanceOf(ApiError);
  });

  it("listOwnedApps returns the owned projection", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        ok: true,
        apps: [{ appId: "app_1", name: "Shop", revoked: false, createdAt: 1791500000 }],
      }),
    );
    await expect(listOwnedApps()).resolves.toEqual([
      { appId: "app_1", name: "Shop", revoked: false, createdAt: 1791500000 },
    ]);
  });

  it("createSelfServeApp posts the optional name and returns the one-time secret", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        ok: true,
        appId: "app_x",
        appSecret: "raw-secret",
        name: "X",
        trial: { otpSms: 7, bulkSms: 7, expiresAt: 123 },
      }, 201),
    );
    const created = await createSelfServeApp("X");
    expect(created.appSecret).toBe("raw-secret");
    expect(created.trial?.otpSms).toBe(7);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ name: "X" });
  });

  it("linkOwnedApp posts the proof and returns the linked app projection", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ ok: true, appId: "haven", name: "Haven", revoked: false }),
    );
    const linked = await linkOwnedApp("haven", "proof-secret");
    expect(linked).toMatchObject({ appId: "haven", name: "Haven", revoked: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      appId: "haven",
      appSecret: "proof-secret",
    });
  });

  it("propagates the server envelope code on link failure (409 rival)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ ok: false, error: "This app is linked to another account", code: "app_already_linked" }, 409),
    );
    await expect(linkOwnedApp("haven", "proof-secret")).rejects.toMatchObject({
      status: 409,
      code: "app_already_linked",
    });
  });

  it("email features hit the ordered routes with the ordered payloads", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, configured: true }));
    await expect(getMailStatus()).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("/v5/auth/mail-status");

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await verifyEmail("raw-token");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ token: "raw-token" });

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await resendVerification();
    expect(fetchMock.mock.calls[2][0]).toContain("/v5/auth/verify-email/resend");

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await forgotPassword("a@example.com");
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({ email: "a@example.com" });

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await resetPassword("raw-token", "new-password-10");
    expect(JSON.parse(fetchMock.mock.calls[4][1].body as string)).toEqual({
      token: "raw-token",
      password: "new-password-10",
    });
  });
});

describe("tenancy + wallet API (F9)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("company CRUD hits the ordered session routes with the ordered bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(
        {
          ok: true,
          company: { id: "co-1", name: "Shop", disabled: false, createdAt: 1 },
          app: {
            appId: "app_x",
            appSecret: "raw-secret",
            deviceEnrollmentSecret: "dev-secret",
            name: "Shop",
          },
          trial: { otpSms: 7, bulkSms: 7, expiresAt: 123 },
        },
        201,
      ),
    );
    const created = await createCompany("Shop");
    expect(fetchMock.mock.calls[0][0]).toContain("/v5/auth/companies");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ name: "Shop" });
    expect(created.app.appSecret).toBe("raw-secret");
    expect(created.trial?.otpSms).toBe(7);

    fetchMock.mockResolvedValueOnce(
      jsonRes({
        ok: true,
        companies: [
          {
            id: "co-1",
            name: "Shop",
            disabled: false,
            createdAt: 1,
            gatewayNumber: "+8801711112233",
            app: { appId: "app_x", name: "Shop", revoked: false },
          },
        ],
      }),
    );
    const list = await listCompanies();
    expect(fetchMock.mock.calls[1][0]).toContain("/v5/auth/companies");
    expect(list[0]?.gatewayNumber).toBe("+8801711112233");

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await renameCompany("co-1", "Renamed");
    expect(fetchMock.mock.calls[2][0]).toContain("/v5/auth/companies/co-1");
    expect(fetchMock.mock.calls[2][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({ name: "Renamed" });

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await disableCompany("co-1");
    expect(fetchMock.mock.calls[3][0]).toContain("/v5/auth/companies/co-1/disable");
    expect(fetchMock.mock.calls[3][1].method).toBe("POST");
  });

  it("wallet reads and wallet purchases use the SESSION plane (no app headers)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        ok: true,
        wallet: {
          otpSmsRemaining: 7,
          bulkSmsRemaining: 3,
          otpExpiresAt: null,
          bulkExpiresAt: null,
          lastTransactionId: null,
          purchasedAt: null,
        },
      }),
    );
    const wallet = await getWallet();
    expect(fetchMock.mock.calls[0][0]).toContain("/v5/auth/wallet");
    expect(wallet.otpSmsRemaining).toBe(7);
    // Session plane: cookie only — no X-App-Id header may be attached.
    expect(fetchMock.mock.calls[0][1].headers?.["X-App-Id"]).toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      jsonRes({
        ok: true,
        transactions: [
          {
            transactionId: "trx-1",
            packageCode: "otp-100",
            smsQuota: 100,
            amountBdt: 20,
            packageType: "otp",
            status: "approved",
            trxId: null,
            requestedAt: 1,
            resolvedAt: 2,
          },
        ],
      }),
    );
    const history = await getWalletTransactions();
    expect(fetchMock.mock.calls[1][0]).toContain("/v5/auth/wallet/transactions");
    expect(history[0]?.packageCode).toBe("otp-100");

    fetchMock.mockResolvedValueOnce(
      jsonRes({ ok: true, transactionId: "trx-2", bkashNumber: "+8801700000000", bkashNote: "Send Money", amountBdt: 20 }, 201),
    );
    const accepted = await requestWalletCredits("otp-100");
    expect(fetchMock.mock.calls[2][0]).toContain("/v5/billing/credits/request");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({ packageCode: "otp-100" });
    expect(accepted.transactionId).toBe("trx-2");

    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, message: "TrxID submitted" }));
    await submitWalletTrx("trx-2", "BK99");
    expect(fetchMock.mock.calls[3][0]).toContain("/v5/billing/credits/submit-trx");
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({
      transactionId: "trx-2",
      trxId: "BK99",
    });
  });
});
