/**
 * Unit + contract tests for the dP Relay v5 client SDK.
 *
 * Every HTTP interaction runs against a stubbed global `fetch`, so the suite
 * asserts the exact wire contract (URL, method, headers, body) without any
 * network. Deliberate guards keep the green honest:
 *  - pre-validation tests assert the stub was NEVER called (fail-fast proof),
 *  - malformed-payload tests prove a wrong 2xx body raises `invalid_response`
 *    instead of silently yielding `undefined`,
 *  - a real `AbortSignal.timeout` proves the timeout path, not a mock of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  AuthenticationError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DpRelayClient,
  DpRelayError,
  InsufficientCreditsError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  isValidE164,
  isValidOtp,
  normalizeOtp,
  normalizePhoneNumber,
  type DpRelayClientOptions,
} from "../src/index.js";

/** Fixture credentials — synthetic values, never real app credentials. */
const CREDENTIALS = { appId: "app_test_0001", appSecret: "app-secret-fixture-0001" };
const PHONE = "+8801712345678";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

interface Reply {
  status: number;
  body?: unknown;
  text?: string;
}

let calls: RecordedCall[];
let reply: Reply;
let fetchMock: Mock;

function installFetch(): void {
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = reply.text !== undefined ? reply.text : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status });
  }) as Mock;
  vi.stubGlobal("fetch", fetchMock);
}

function makeClient(overrides: Partial<DpRelayClientOptions> = {}): DpRelayClient {
  return new DpRelayClient({ ...CREDENTIALS, ...overrides });
}

function lastCall(): RecordedCall {
  const entry = calls[calls.length - 1];
  if (entry === undefined) throw new Error("expected at least one recorded fetch call");
  return entry;
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

function sentHeader(name: string): unknown {
  const headers = lastCall().init.headers as Record<string, string>;
  return headers[name];
}

/**
 * Run an action that must fail client-side with a ValidationError and prove
 * the network stub was never touched (fail-fast, not fail-later).
 */
async function expectNoRequest(run: () => unknown): Promise<ValidationError> {
  const error = await Promise.resolve()
    .then(run)
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(error).toBeInstanceOf(ValidationError);
  expect(fetchMock).not.toHaveBeenCalled();
  return error as ValidationError;
}

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: {} };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("package defaults", () => {
  it("pins the documented v5 API origin and timeout budget", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.dprelay.digital-papyrus.com");
    expect(DEFAULT_TIMEOUT_MS).toBe(30000);
  });
});

describe("constructor and configuration", () => {
  it("uses the default baseUrl and timeout, and always attaches an AbortSignal", async () => {
    reply = { status: 201, body: { ok: true, sessionId: "sess_1", expiresAt: 1790000000 } };
    const client = makeClient();
    await client.sendOtp({ phoneNumber: PHONE });
    expect(lastCall().url).toBe(`${DEFAULT_BASE_URL}/v5/otp/send`);
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes a trailing slash in a custom baseUrl", async () => {
    reply = {
      status: 200,
      body: { ok: true, status: "pending", expiresAt: 1790000000, attemptsLeft: 3, lockedUntil: null, verifiedAt: null },
    };
    const client = makeClient({ baseUrl: "https://api.example.test/" });
    await client.getOtpStatus(PHONE);
    expect(lastCall().url).toBe(`https://api.example.test/v5/otp/status?phone=${encodeURIComponent(PHONE)}`);
  });

  it("rejects missing, empty and non-string credentials before any request", async () => {
    const missing = await expectNoRequest(
      () => new DpRelayClient({ ...CREDENTIALS, appId: undefined as unknown as string }),
    );
    expect(missing.code).toBe("invalid_app_id");
    expect(missing.statusCode).toBeNull();

    const empty = await expectNoRequest(() => new DpRelayClient({ ...CREDENTIALS, appId: "  " }));
    expect(empty.code).toBe("invalid_app_id");

    const blankSecret = await expectNoRequest(() => new DpRelayClient({ ...CREDENTIALS, appSecret: "" }));
    expect(blankSecret.code).toBe("invalid_app_secret");
  });

  it("rejects a non-finite or non-positive timeoutMs", async () => {
    const notFinite = await expectNoRequest(
      () => new DpRelayClient({ ...CREDENTIALS, timeoutMs: Number.NaN }),
    );
    expect(notFinite.code).toBe("invalid_timeout");

    const zero = await expectNoRequest(() => new DpRelayClient({ ...CREDENTIALS, timeoutMs: 0 }));
    expect(zero.code).toBe("invalid_timeout");
  });
});

describe("authenticated transport", () => {
  it("sends X-App-Id / X-App-Secret and JSON headers on POST and GET alike", async () => {
    reply = { status: 201, body: { ok: true, sessionId: "sess_1", expiresAt: 1790000000 } };
    const client = makeClient();
    await client.sendOtp({ phoneNumber: PHONE });
    expect(sentHeader("X-App-Id")).toBe(CREDENTIALS.appId);
    expect(sentHeader("X-App-Secret")).toBe(CREDENTIALS.appSecret);
    expect(sentHeader("Content-Type")).toBe("application/json");

    reply = {
      status: 200,
      body: { ok: true, status: "pending", expiresAt: 1790000000, attemptsLeft: 3, lockedUntil: null, verifiedAt: null },
    };
    await client.getOtpStatus(PHONE);
    expect(calls).toHaveLength(2);
    expect(sentHeader("X-App-Id")).toBe(CREDENTIALS.appId);
    expect(sentHeader("X-App-Secret")).toBe(CREDENTIALS.appSecret);
    expect(lastCall().init.method).toBe("GET");
    expect(lastCall().init.body).toBeUndefined();
  });
});

describe("sendOtp", () => {
  it("posts the normalized phone and returns the session receipt", async () => {
    reply = { status: 201, body: { ok: true, sessionId: "sess_1", expiresAt: 1790000000 } };
    const client = makeClient();
    const receipt = await client.sendOtp({ phoneNumber: "+880 1712-345678", mode: "byod" });
    expect(receipt).toEqual({ sessionId: "sess_1", expiresAt: 1790000000 });
    expect(lastCall().url).toBe(`${DEFAULT_BASE_URL}/v5/otp/send`);
    expect(lastCall().init.method).toBe("POST");
    expect(sentBody()).toEqual({ phone: PHONE, mode: "byod" });
  });

  it("omits an unset mode from the wire payload", async () => {
    reply = { status: 201, body: { ok: true, sessionId: "sess_1", expiresAt: 1790000000 } };
    const client = makeClient();
    await client.sendOtp({ phoneNumber: PHONE, mode: "managed" });
    expect(sentBody()).toEqual({ phone: PHONE, mode: "managed" });

    await client.sendOtp({ phoneNumber: PHONE });
    expect("mode" in sentBody()).toBe(false);
  });

  it("rejects a non-E.164 phone without issuing a request", async () => {
    const error = await expectNoRequest(() => makeClient().sendOtp({ phoneNumber: "01712345678" }));
    expect(error.code).toBe("invalid_phone");
    expect(error.message).toContain("E.164");
  });

  it("rejects an unknown delivery mode without issuing a request", async () => {
    const error = await expectNoRequest(() =>
      makeClient().sendOtp({ phoneNumber: PHONE, mode: "sms" as unknown as "byod" }),
    );
    expect(error.code).toBe("invalid_mode");
  });
});

describe("verifyOtp", () => {
  it("posts phone/otp and reports a confirmed verification", async () => {
    reply = { status: 200, body: { ok: true, verified: true } };
    const client = makeClient();
    const result = await client.verifyOtp({ phoneNumber: PHONE, otp: " 123456 ", sessionId: "sess_1" });
    expect(result).toEqual({ verified: true });
    expect(lastCall().url).toBe(`${DEFAULT_BASE_URL}/v5/otp/verify`);
    expect(sentBody()).toEqual({ phone: PHONE, otp: "123456", sessionId: "sess_1" });
  });

  it("leaves sessionId off the wire when it was not supplied", async () => {
    reply = { status: 200, body: { ok: true, verified: true } };
    const client = makeClient();
    await client.verifyOtp({ phoneNumber: PHONE, otp: "123456" });
    expect("sessionId" in sentBody()).toBe(false);
  });

  it("fails closed when a 2xx body does not confirm the code", async () => {
    reply = { status: 200, body: { ok: true, verified: false } };
    const client = makeClient();
    const result = await client.verifyOtp({ phoneNumber: PHONE, otp: "123456" });
    expect(result).toEqual({ verified: false });
  });

  it("rejects malformed phone/otp inputs without issuing a request", async () => {
    const client = makeClient();
    const badPhone = await expectNoRequest(() =>
      client.verifyOtp({ phoneNumber: "+8801712345678901234", otp: "123456" }),
    );
    expect(badPhone.code).toBe("invalid_phone");

    const shortOtp = await expectNoRequest(() => client.verifyOtp({ phoneNumber: PHONE, otp: "12345" }));
    expect(shortOtp.code).toBe("invalid_otp_format");

    const nonStringOtp = await expectNoRequest(() =>
      client.verifyOtp({ phoneNumber: PHONE, otp: 123456 as unknown as string }),
    );
    expect(nonStringOtp.code).toBe("invalid_otp_format");
  });

  it("maps 401 invalid_otp to a failed result carrying attemptsRemaining", async () => {
    reply = { status: 401, body: { ok: false, error: "Invalid verification code", code: "invalid_otp", attemptsLeft: 2 } };
    const client = makeClient();
    const result = await client.verifyOtp({ phoneNumber: PHONE, otp: "000000" });
    expect(result).toEqual({ verified: false, attemptsRemaining: 2 });
  });

  it("leaves attemptsRemaining unset when the server omits the counter", async () => {
    reply = { status: 401, body: { ok: false, error: "Invalid verification code", code: "invalid_otp" } };
    const client = makeClient();
    const result = await client.verifyOtp({ phoneNumber: PHONE, otp: "000000" });
    expect(result).toEqual({ verified: false });
    expect(result.attemptsRemaining).toBeUndefined();
  });

  it("maps 423 otp_locked to a lockout timestamp", async () => {
    reply = { status: 423, body: { ok: false, error: "Too many failed attempts", code: "otp_locked", retryAfterSec: 300 } };
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    const result = await client.verifyOtp({ phoneNumber: PHONE, otp: "000000" });
    expect(result.verified).toBe(false);
    expect(result.attemptsRemaining).toBeUndefined();
    expect(result.lockoutUntil).toBeGreaterThanOrEqual(before + 300);
  });

  it("maps 423 otp_locked without a retry hint to a bare failure", async () => {
    reply = { status: 423, body: { ok: false, error: "Too many failed attempts", code: "otp_locked" } };
    const client = makeClient();
    const result = await client.verifyOtp({ phoneNumber: PHONE, otp: "000000" });
    expect(result).toEqual({ verified: false });
  });

  it("throws ValidationError for an expired session so the caller resends", async () => {
    reply = { status: 400, body: { ok: false, error: "No active OTP session for this number", code: "otp_expired" } };
    const client = makeClient();
    const error = (await client.verifyOtp({ phoneNumber: PHONE, otp: "123456" }).catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("otp_expired");
    expect(error.statusCode).toBe(400);
  });

  it("still surfaces server-level failures (402) as their typed error", async () => {
    reply = { status: 402, body: { ok: false, error: "Insufficient OTP SMS credits", code: "insufficient_credits" } };
    const client = makeClient();
    const error = (await client.verifyOtp({ phoneNumber: PHONE, otp: "123456" }).catch((e: unknown) => e)) as InsufficientCreditsError;
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error.statusCode).toBe(402);
  });
});

describe("getOtpStatus", () => {
  it("reads a pending session, including null lockout/verification stamps", async () => {
    reply = {
      status: 200,
      body: { ok: true, status: "pending", expiresAt: 1790000000, attemptsLeft: 3, lockedUntil: null, verifiedAt: null },
    };
    const client = makeClient();
    const status = await client.getOtpStatus(PHONE);
    expect(status).toEqual({ status: "pending", expiresAt: 1790000000, attemptsLeft: 3, lockedUntil: null, verifiedAt: null });
  });

  it("reads a locked, verified session with numeric stamps", async () => {
    reply = {
      status: 200,
      body: { ok: true, status: "verified", expiresAt: 1790000000, attemptsLeft: 0, lockedUntil: 1790000099, verifiedAt: 1790000042 },
    };
    const client = makeClient();
    const status = await client.getOtpStatus(PHONE);
    expect(status.lockedUntil).toBe(1790000099);
    expect(status.verifiedAt).toBe(1790000042);
    expect(status.status).toBe("verified");
  });

  it("rejects a non-E.164 phone without issuing a request", async () => {
    const error = await expectNoRequest(() => makeClient().getOtpStatus("not-a-phone"));
    expect(error.code).toBe("invalid_phone");
  });

  it("maps 404 to NotFoundError when no session exists", async () => {
    reply = { status: 404, body: { ok: false, error: "No OTP session for this number", code: "not_found" } };
    const client = makeClient();
    const error = (await client.getOtpStatus(PHONE).catch((e: unknown) => e)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
  });
});

describe("previewBulk", () => {
  it("posts raw CSV and derives the counts around the server checksum", async () => {
    reply = {
      status: 200,
      body: {
        ok: true,
        total: 3,
        sampleFirst5: ["+8801711111111", "+8801722222222"],
        invalidRows: [{ line: 4, reason: "not a valid E.164 number (expected +<country><number>)" }],
        checksum: "chk_abc123",
        headerSkipped: true,
        perCampaignLimit: 5000,
      },
    };
    const client = makeClient();
    const preview = await client.previewBulk({ csvData: "phone\n+8801711111111\n+8801722222222" });
    expect(lastCall().url).toBe(`${DEFAULT_BASE_URL}/v5/bulk/campaigns/preview`);
    expect(sentBody()).toEqual({ csv: "phone\n+8801711111111\n+8801722222222" });
    expect(preview).toEqual({
      count: 4,
      validCount: 3,
      invalidCount: 1,
      estimatedCredits: 3,
      checksum: "chk_abc123",
      invalidRows: [{ line: 4, reason: "not a valid E.164 number (expected +<country><number>)" }],
      sampleFirst5: ["+8801711111111", "+8801722222222"],
      headerSkipped: true,
      perCampaignLimit: 5000,
    });
  });

  it("posts a normalized recipient list alongside the validated message", async () => {
    reply = {
      status: 200,
      body: { ok: true, total: 2, sampleFirst5: [], invalidRows: [], checksum: "chk_def456", headerSkipped: false, perCampaignLimit: 5000 },
    };
    const client = makeClient();
    const preview = await client.previewBulk({ recipients: ["+880 1711-111111", "+8801722222222"], message: "Flash sale!" });
    expect(sentBody()).toEqual({ phones: ["+8801711111111", "+8801722222222"], message: "Flash sale!" });
    expect(preview.validCount).toBe(2);
    expect(preview.headerSkipped).toBe(false);
  });

  it("rejects unusable preview arguments without issuing a request", async () => {
    const client = makeClient();

    const noList = await expectNoRequest(() => client.previewBulk({} as unknown as { csvData: string }));
    expect(noList.code).toBe("invalid_recipients");

    const emptyCsv = await expectNoRequest(() => client.previewBulk({ csvData: "   " }));
    expect(emptyCsv.code).toBe("invalid_recipients");

    const nonStringCsv = await expectNoRequest(() => client.previewBulk({ csvData: 42 as unknown as string }));
    expect(nonStringCsv.code).toBe("invalid_recipients");

    const emptyRecipients = await expectNoRequest(() => client.previewBulk({ recipients: [], message: "hello" }));
    expect(emptyRecipients.code).toBe("invalid_recipients");

    const badRecipient = await expectNoRequest(() =>
      client.previewBulk({ recipients: ["+8801711111111", "01712345678"], message: "hello" }),
    );
    expect(badRecipient.code).toBe("invalid_phone");

    const blankMessage = await expectNoRequest(() =>
      client.previewBulk({ recipients: ["+8801711111111"], message: "  " }),
    );
    expect(blankMessage.code).toBe("invalid_message");
  });
});

describe("createBulkCampaign", () => {
  it("submits the previewed list with its checksum and maps the receipt", async () => {
    reply = {
      status: 201,
      body: {
        ok: true,
        campaignId: "cmp_1",
        status: "queued",
        totalRecipients: 3,
        creditsReserved: 3,
        unlimitedPass: false,
        charset: "gsm7",
        sourceType: "csv",
        duplicateCount: 2,
      },
    };
    const client = makeClient();
    const created = await client.createBulkCampaign({
      name: "Spring sale",
      message: "20% off today",
      recipients: [PHONE, "+8801722222222"],
      checksum: "chk_abc123",
    });
    expect(lastCall().url).toBe(`${DEFAULT_BASE_URL}/v5/bulk/campaigns`);
    expect(sentBody()).toEqual({
      name: "Spring sale",
      message: "20% off today",
      phones: [PHONE, "+8801722222222"],
      checksum: "chk_abc123",
      sourceType: "csv",
    });
    expect(created).toEqual({
      campaignId: "cmp_1",
      status: "queued",
      enqueuedCount: 3,
      totalRecipients: 3,
      creditsReserved: 3,
      unlimitedPass: false,
      charset: "gsm7",
      duplicateCount: 2,
    });
  });

  it("leaves duplicateCount undefined when the server reports no duplicates", async () => {
    reply = {
      status: 201,
      body: {
        ok: true,
        campaignId: "cmp_2",
        status: "queued",
        totalRecipients: 1,
        creditsReserved: 1,
        unlimitedPass: true,
        charset: "ucs2",
        sourceType: "csv",
      },
    };
    const client = makeClient();
    const created = await client.createBulkCampaign({
      name: "Winback",
      message: "We miss you",
      recipients: [PHONE],
      checksum: "chk_xyz789",
    });
    expect(created.duplicateCount).toBeUndefined();
    expect(created.unlimitedPass).toBe(true);
  });

  it("rejects unusable campaign arguments without issuing a request", async () => {
    const client = makeClient();
    const base = { name: "n", message: "m", recipients: [PHONE], checksum: "chk" };

    const noName = await expectNoRequest(() => client.createBulkCampaign({ ...base, name: "" }));
    expect(noName.code).toBe("invalid_campaign_name");

    const noMessage = await expectNoRequest(() => client.createBulkCampaign({ ...base, message: " " }));
    expect(noMessage.code).toBe("invalid_message");

    const noRecipients = await expectNoRequest(() => client.createBulkCampaign({ ...base, recipients: [] }));
    expect(noRecipients.code).toBe("invalid_recipients");

    const badRecipient = await expectNoRequest(() =>
      client.createBulkCampaign({ ...base, recipients: ["nope"] }),
    );
    expect(badRecipient.code).toBe("invalid_phone");

    const noChecksum = await expectNoRequest(() => client.createBulkCampaign({ ...base, checksum: "" }));
    expect(noChecksum.code).toBe("checksum_required");
  });

  it("maps 400 checksum_mismatch to ValidationError", async () => {
    reply = { status: 400, body: { ok: false, error: "Recipient list changed since preview", code: "checksum_mismatch" } };
    const client = makeClient();
    const error = (await client
      .createBulkCampaign({ name: "n", message: "m", recipients: [PHONE], checksum: "stale" })
      .catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("checksum_mismatch");
  });
});

describe("getCampaignStatus", () => {
  it("flattens the campaign payload into the status result", async () => {
    reply = {
      status: 200,
      body: {
        ok: true,
        campaign: {
          campaignId: "cmp_1",
          name: "Spring sale",
          status: "sending",
          sourceType: "csv",
          totalRecipients: 100,
          sentCount: 42,
          failedCount: 1,
          queuedCount: 57,
          createdAt: 1790000000,
          startedAt: 1790000010,
          completedAt: null,
          unlimitedPass: false,
          message: "20% off today",
          sourceGroupIds: null,
        },
      },
    };
    const client = makeClient();
    const status = await client.getCampaignStatus("cmp_1");
    expect(lastCall().url).toBe(`${DEFAULT_BASE_URL}/v5/bulk/campaigns/cmp_1`);
    expect(lastCall().init.method).toBe("GET");
    expect(status).toEqual({
      campaignId: "cmp_1",
      name: "Spring sale",
      status: "sending",
      sourceType: "csv",
      totalRecipients: 100,
      sentCount: 42,
      failedCount: 1,
      queuedCount: 57,
      createdAt: 1790000000,
      startedAt: 1790000010,
      completedAt: null,
      unlimitedPass: false,
    });
  });

  it("rejects an empty campaign id without issuing a request", async () => {
    const error = await expectNoRequest(() => makeClient().getCampaignStatus(""));
    expect(error.code).toBe("invalid_campaign_id");
  });

  it("maps 404 to NotFoundError for an unknown campaign", async () => {
    reply = { status: 404, body: { ok: false, error: "Campaign not found", code: "campaign_not_found" } };
    const client = makeClient();
    const error = (await client.getCampaignStatus("cmp_missing").catch((e: unknown) => e)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("campaign_not_found");
  });
});

describe("HTTP error mapping", () => {
  const cases: { status: number; body: unknown; expected: string }[] = [
    { status: 400, body: { ok: false, error: "phone must be strict E.164", code: "invalid_phone" }, expected: "ValidationError" },
    { status: 401, body: { ok: false, error: "Unknown X-App-Id", code: "unknown_app" }, expected: "AuthenticationError" },
    { status: 402, body: { ok: false, error: "Not enough bulk credits.", code: "no_credits_row" }, expected: "InsufficientCreditsError" },
    { status: 429, body: { ok: false, error: "Too many OTP requests for this number", code: "rate_limited" }, expected: "RateLimitError" },
  ];

  it.each(cases)("maps $status to $expected", async ({ status, body, expected }) => {
    reply = { status, body };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error.constructor.name).toBe(expected);
    expect(error.statusCode).toBe(status);
    expect(error.name).toBe(expected);
  });

  it("falls back to a status-derived envelope when the error body has no code", async () => {
    reply = { status: 429, body: { ok: false, error: "slow down" } };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.code).toBe("http_429");
    expect(error.message).toBe("slow down");
  });

  it("falls back to a status-derived message when the error body has no error text", async () => {
    reply = { status: 400, body: { ok: false, code: "invalid_phone" } };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe("HTTP 400");
  });

  it("types an empty error body instead of crashing on it", async () => {
    reply = { status: 401, text: "" };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as AuthenticationError;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("http_401");
    expect(error.message).toBe("HTTP 401");
  });

  it("types a non-JSON error body instead of crashing on it", async () => {
    reply = { status: 400, text: '"boom"' };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("http_400");
  });

  it("types a non-object JSON error body instead of crashing on it", async () => {
    reply = { status: 400, body: [1, 2] };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("http_400");
    expect(error.message).toBe("HTTP 400");
  });

  it("maps an unparseable 5xx body to the base DpRelayError", async () => {
    reply = { status: 503, text: "<html>gateway down</html>" };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.name).toBe("DpRelayError");
    expect(error.code).toBe("http_503");
    expect(error.statusCode).toBe(503);
  });
});

describe("malformed success payloads", () => {
  it("raises invalid_response when sendOtp's receipt lacks sessionId", async () => {
    reply = { status: 201, body: { ok: true, expiresAt: 1790000000 } };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error.code).toBe("invalid_response");
    expect(error.statusCode).toBeNull();
  });

  it("raises invalid_response when the status payload lacks expiresAt", async () => {
    reply = { status: 200, body: { ok: true, status: "pending" } };
    const error = (await makeClient().getOtpStatus(PHONE).catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("expiresAt");
  });

  it("raises invalid_response when the preview payload lacks invalidRows", async () => {
    reply = { status: 200, body: { ok: true, total: 1, checksum: "chk" } };
    const error = (await makeClient().previewBulk({ csvData: "x" }).catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("invalidRows");
  });

  it("raises invalid_response when the campaign object is missing", async () => {
    reply = { status: 200, body: { ok: true } };
    const error = (await makeClient().getCampaignStatus("cmp_1").catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("campaign");
  });

  it("raises invalid_response when a 2xx body is an array instead of an object", async () => {
    reply = { status: 201, body: [1, 2] };
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as DpRelayError;
    expect(error).toBeInstanceOf(DpRelayError);
    expect(error.code).toBe("invalid_response");
  });
});

describe("transport failures", () => {
  it("times out via AbortSignal.timeout and reports NetworkError(timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const client = makeClient({ timeoutMs: 10 });
    const error = (await client.sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.code).toBe("timeout");
    expect(error.statusCode).toBeNull();
    expect(error.message).toContain("10ms");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("maps a rejected fetch to NetworkError(network_error)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:443"))));
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("maps a non-Error rejection to NetworkError without crashing on it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject("socket closed by peer")));
    const error = (await makeClient().sendOtp({ phoneNumber: PHONE }).catch((e: unknown) => e)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("socket closed by peer");
  });

  it("maps a response body that dies mid-stream to NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          status: 200,
          ok: true,
          text: () => Promise.reject(new Error("stream reset")),
        }) as unknown as Response,
      ),
    );
    const error = (await makeClient().getOtpStatus(PHONE).catch((e: unknown) => e)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("stream reset");
  });
});

describe("validation helpers", () => {
  it("normalizes phone numbers to strict E.164 or null", () => {
    expect(normalizePhoneNumber("+8801712345678")).toBe("+8801712345678");
    expect(normalizePhoneNumber("+880 1712-345678")).toBe("+8801712345678");
    expect(normalizePhoneNumber("  +1 555 123 4567 ")).toBe("+15551234567");
    expect(normalizePhoneNumber("01712345678")).toBeNull();
    expect(normalizePhoneNumber("+012345678")).toBeNull();
    expect(normalizePhoneNumber("+12")).toBeNull();
    expect(normalizePhoneNumber("+1234567890123456")).toBeNull();
    expect(normalizePhoneNumber("")).toBeNull();
    expect(normalizePhoneNumber(undefined)).toBeNull();
    expect(normalizePhoneNumber(8801712345678 as unknown as string)).toBeNull();
  });

  it("classifies E.164 candidates", () => {
    expect(isValidE164("+8801712345678")).toBe(true);
    expect(isValidE164("+880 1712 345678")).toBe(true);
    expect(isValidE164("1712345678")).toBe(false);
    expect(isValidE164(null)).toBe(false);
  });

  it("normalizes OTP codes to exactly six digits or null", () => {
    expect(normalizeOtp("123456")).toBe("123456");
    expect(normalizeOtp(" 123456 ")).toBe("123456");
    expect(normalizeOtp("12345")).toBeNull();
    expect(normalizeOtp("12345x")).toBeNull();
    expect(normalizeOtp("1234567")).toBeNull();
    expect(normalizeOtp(123456 as unknown as string)).toBeNull();
  });

  it("classifies OTP candidates", () => {
    expect(isValidOtp("042131")).toBe(true);
    expect(isValidOtp("42131")).toBe(false);
    expect(isValidOtp(undefined)).toBe(false);
  });
});
