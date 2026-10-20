/**
 * STAGE F11 (ISSUE-123): Brevo HTTP transport in the mailer.
 *
 * Render blocks ALL outbound SMTP (every relay ETIMEDOUTs at CONN from Render
 * while the same connections succeed elsewhere), so `host = api.brevo.com`
 * must send through Brevo's HTTP API. These tests pin the transport contract:
 * the exact endpoint, the `api-key` header carrying the stored password, the
 * exact JSON body, a non-2xx surfacing status + body excerpt through the
 * existing error surface, and — negatively — that any other host never touches
 * `fetch` (the SMTP path stays intact, so stackmail works the day hosting
 * leaves Render). No real network egress: `fetch` is stubbed for every case,
 * and the SMTP negative test only reaches refused loopback.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { sendMail } from "../src/services/mailer.js";
import type { FastifyInstance } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const OPERATOR = "test-operator-secret-0123456789abcdef";
/** Fake xkeysib key — the real ones stay in Brevo/#/operator, never in the repo. */
const BREVO_API_KEY = "xkeysib-api-key-for-tests-000000";

const BREVO_CONFIG = {
  // Port/username are display-only in HTTP mode (ordered: no schema change).
  host: "api.brevo.com",
  port: 587,
  username: "bf15b3001@smtp-brevo.test",
  password: BREVO_API_KEY,
  fromAddress: "admin@dprelay.test",
};

let app: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;

/** Replaces global fetch with a canned Brevo-style response. */
function stubFetch(result: { ok: boolean; status: number; statusText: string; body: string }): void {
  fetchMock = vi.fn(async () => ({
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    text: async () => result.body,
  }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
}

function operatorHeaders(): Record<string, string> {
  return { authorization: `Bearer ${OPERATOR}` };
}

/** Saves a mail config through the real route (password goes in encrypted). */
async function saveConfig(config: typeof BREVO_CONFIG): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: "/v5/admin/mail-config",
    headers: operatorHeaders(),
    payload: config,
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  app = buildApp({
    dbPath: join(testTmpDir("dprelay-brevo-test-"), "test.db"),
    env: { JWT_SECRET: TEST_JWT_SECRET, OPERATOR_SECRET: OPERATOR },
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  stubFetch({ ok: true, status: 200, statusText: "OK", body: '{"messageId":"msg-test"}' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Brevo HTTP mode (host = api.brevo.com)", () => {
  it("posts the exact Brevo payload with the stored key as api-key", async () => {
    await saveConfig(BREVO_CONFIG);

    await sendMail(
      app.db,
      TEST_JWT_SECRET,
      "recipient@example.test",
      "Confirm your email for dP Relay",
      "Open this link to verify your address:\nhttps://app.example.test/#/verify/raw-token",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    // The stored password field IS the API key in this mode (ordered).
    expect(init.headers).toMatchObject({
      "api-key": BREVO_API_KEY,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      sender: { email: "admin@dprelay.test" },
      to: [{ email: "recipient@example.test" }],
      subject: "Confirm your email for dP Relay",
      textContent: "Open this link to verify your address:\nhttps://app.example.test/#/verify/raw-token",
    });
    // Same timeout wrapper as the SMTP path — a dead endpoint must not hang.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws with the status and a response-body excerpt on a non-2xx", async () => {
    stubFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: '{"code":"unauthorized","message":"Access denied"}',
    });
    await saveConfig(BREVO_CONFIG);

    const err = await sendMail(app.db, TEST_JWT_SECRET, "recipient@example.test", "subject", "body").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("brevo_http_send_failed: 401");
    expect(message).toContain('{"code":"unauthorized"');
  });

  it("answers 200 on the operator test button when Brevo accepts the send", async () => {
    await saveConfig(BREVO_CONFIG);

    const res = await app.inject({
      method: "POST",
      url: "/v5/admin/mail-config/test",
      headers: operatorHeaders(),
      payload: { to: "operator@example.test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("maps a Brevo failure to the same structured 502 as an SMTP failure", async () => {
    stubFetch({ ok: false, status: 500, statusText: "Internal Server Error", body: "brevo upstream error" });
    await saveConfig(BREVO_CONFIG);

    const res = await app.inject({
      method: "POST",
      url: "/v5/admin/mail-config/test",
      headers: operatorHeaders(),
      payload: { to: "operator@example.test" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, code: "mail_send_failed" });
  });
});

describe("SMTP mode untouched (any other host)", () => {
  it("never calls fetch — the nodemailer path still runs", async () => {
    // 127.0.0.1:9 → instant ECONNREFUSED on loopback; nothing leaves the machine.
    await saveConfig({ ...BREVO_CONFIG, host: "127.0.0.1", port: 9 });

    await expect(sendMail(app.db, TEST_JWT_SECRET, "recipient@example.test", "subject", "body")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
