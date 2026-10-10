import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  appFetch,
  connectApp,
  disconnectApp,
  getConnectedApp,
  request,
  setAppUnauthorizedHandler,
} from "../src/api";

/** JSON Response helper for the fetch mock. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("credential storage (sessionStorage)", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips app credentials and clears them on disconnect", () => {
    expect(getConnectedApp()).toBeNull();
    connectApp("app-1", "secret-1");
    expect(getConnectedApp()).toEqual({ appId: "app-1", appSecret: "secret-1" });
    disconnectApp();
    expect(getConnectedApp()).toBeNull();
  });
});

describe("request plumbing", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    setAppUnauthorizedHandler(null);
  });

  it("throws ApiError carrying the server envelope code and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ ok: false, error: "No credits left", code: "insufficient_credits" }, 402),
      ),
    );
    await expect(request("/v5/otp/send", { method: "POST", body: "{}" })).rejects.toMatchObject({
      name: "ApiError",
      status: 402,
      code: "insufficient_credits",
      message: "No credits left",
    });
  });

  it("maps transport failure to network_error with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      }),
    );
    await expect(request("/v5/billing/credits", {})).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
  });

  it("sets Content-Type only when a body is present (Fastify empty-JSON-body rule)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonRes({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await request("/v5/billing/packages", { method: "POST" });
    const noBodyHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(noBodyHeaders["Content-Type"]).toBeUndefined();

    await request("/v5/billing/credits/request", { method: "POST", body: "{}" });
    const withBodyHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(withBodyHeaders["Content-Type"]).toBe("application/json");
  });
});

describe("appFetch (app plane)", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    setAppUnauthorizedHandler(null);
  });

  it("sends X-App-Id and X-App-Secret headers from session storage", async () => {
    connectApp("demo-app", "demo-secret");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonRes({ ok: true, packages: [] }));
    vi.stubGlobal("fetch", fetchMock);

    // STAGE F9: listPackages moved to the session plane (the catalog route is
    // public server-side); appFetch itself is still the app-plane transport —
    // exercise it directly.
    await appFetch("/v5/billing/packages");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-App-Id"]).toBe("demo-app");
    expect(headers["X-App-Secret"]).toBe("demo-secret");
    expect(fetchMock.mock.calls[0][0]).toBe("/v5/billing/packages");
  });

  it("fails fast without stored credentials and never hits the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(appFetch("/v5/billing/credits")).rejects.toMatchObject({
      code: "app_not_connected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops stored credentials and notifies the shell on a 401", async () => {
    connectApp("demo-app", "wrong-secret");
    const onUnauthorized = vi.fn();
    setAppUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ ok: false, error: "Unknown X-App-Id", code: "unknown_app" }, 401)),
    );

    await expect(appFetch("/v5/billing/credits")).rejects.toMatchObject({
      status: 401,
      code: "unknown_app",
    });
    expect(getConnectedApp()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials on non-401 failures", async () => {
    connectApp("demo-app", "demo-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ ok: false, error: "boom", code: "server_error" }, 500)),
    );
    await expect(appFetch("/v5/billing/credits")).rejects.toBeInstanceOf(ApiError);
    expect(getConnectedApp()).toEqual({ appId: "demo-app", appSecret: "demo-secret" });
  });
});
