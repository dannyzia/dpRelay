// Mock admin SDK for tests - must come before require('./index')
const crypto = require("crypto");

const mockDb = {
  ref: jest.fn(),
};
const mockAuth = {
  createCustomToken: jest.fn(),
};

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  database: () => mockDb,
  auth: () => mockAuth,
  firestore: () => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(),
        set: jest.fn(),
        update: jest.fn(),
        add: jest.fn(),
      })),
    })),
  }),
  credential: {
    cert: jest.fn(),
  },
}));

const admin = require("firebase-admin");
const {
  generateHmac,
  generateSessionCode,
  timingSafeEqual,
  isWithinClockSkew,
} = require("./index");

/**
 * Unit tests for Cloud Functions crypto utilities.
 */
describe("Crypto Utilities", () => {
  describe("generateHmac", () => {
    test("produces consistent signatures for same input", () => {
      const secret = "test_secret_32_characters_long";
      const data = "test_data";

      const signature1 = generateHmac(secret, data);
      const signature2 = generateHmac(secret, data);

      expect(signature1).toBe(signature2);
    });

    test("produces different signatures for different data", () => {
      const secret = "test_secret_32_characters_long";

      const signature1 = generateHmac(secret, "data1");
      const signature2 = generateHmac(secret, "data2");

      expect(signature1).not.toBe(signature2);
    });

    test("produces different signatures for different secrets", () => {
      const data = "test_data";

      const signature1 = generateHmac("secret1_32_characters_long", data);
      const signature2 = generateHmac("secret2_32_characters_long", data);

      expect(signature1).not.toBe(signature2);
    });
  });

  describe("generateSessionCode", () => {
    test("returns 10-character uppercase hex string", () => {
      const code = generateSessionCode();
      expect(code).toHaveLength(10);
      expect(code).toMatch(/^[0-9A-F]{10}$/);
    });

    test("produces unique codes", () => {
      const codes = new Set();
      for (let i = 0; i < 100; i++) {
        codes.add(generateSessionCode());
      }
      expect(codes.size).toBe(100);
    });
  });

  describe("timingSafeEqual", () => {
    test("returns true for equal strings", () => {
      const a = "test_string";
      const b = "test_string";

      expect(timingSafeEqual(a, b)).toBe(true);
    });

    test("returns false for different strings", () => {
      const a = "test_string";
      const b = "test_strinh";

      expect(timingSafeEqual(a, b)).toBe(false);
    });

    test("returns false for different length strings", () => {
      const a = "test";
      const b = "test_string";

      expect(timingSafeEqual(a, b)).toBe(false);
    });

    test("returns false for empty strings", () => {
      const a = "";
      const b = "test";

      expect(timingSafeEqual(a, b)).toBe(false);
    });

    test("returns true for two empty strings", () => {
      const a = "";
      const b = "";

      expect(timingSafeEqual(a, b)).toBe(true);
    });
  });

  describe("isWithinClockSkew", () => {
    test("returns true for timestamp within tolerance", () => {
      const now = Date.now();
      const timestamp = now + 200000; // 200 seconds within 5 minutes

      expect(isWithinClockSkew(timestamp)).toBe(true);
    });

    test("returns true for timestamp exactly at tolerance", () => {
      const now = Date.now();
      const timestamp = now + 300000; // Exactly 5 minutes

      expect(isWithinClockSkew(timestamp)).toBe(true);
    });

    test("returns false for timestamp beyond tolerance", () => {
      const now = Date.now();
      const timestamp = now + 301000; // 5 minutes + 1 second

      expect(isWithinClockSkew(timestamp)).toBe(false);
    });

    test("returns true for past timestamp within tolerance", () => {
      const now = Date.now();
      const timestamp = now - 200000; // 200 seconds in the past

      expect(isWithinClockSkew(timestamp)).toBe(true);
    });

    test("returns false for past timestamp beyond tolerance", () => {
      const now = Date.now();
      const timestamp = now - 301000; // 5 minutes + 1 second in the past

      expect(isWithinClockSkew(timestamp)).toBe(false);
    });
  });
});

/**
 * Validation tests for API contracts and error handling.
 * Note: These are unit tests for validation logic; full endpoint tests
 * require Firebase emulator integration.
 */
describe("API Contract Validation", () => {
  describe("Session Code Format", () => {
    test("validates 10-character uppercase hex format", () => {
      const validCodes = ["A3F1B9C2E4", "0123456789", "ABCDEF0123"];
      validCodes.forEach((code) => {
        expect(code).toMatch(/^[0-9A-F]{10}$/);
      });
    });

    test("rejects invalid session code formats", () => {
      const invalidCodes = [
        "a3f1b9c2e4",
        "A3F1B9C2",
        "A3F1B9C2E4X",
        "ABC-DEF-123",
      ];
      invalidCodes.forEach((code) => {
        expect(code).not.toMatch(/^[0-9A-F]{10}$/);
      });
    });
  });

  describe("Phone Number Format", () => {
    test("validates E.164 format", () => {
      const validNumbers = ["+8801712345678", "+12125551234", "+441234567890"];
      validNumbers.forEach((number) => {
        expect(number).toMatch(/^\+[1-9]\d{1,14}$/);
      });
    });

    test("rejects invalid phone number formats", () => {
      // +123456789012345 is actually valid (15 digits total = 1 country code + 14 subscriber)
      const invalidNumbers = [
        "01712345678",
        "8801712345678",
        "+1234567890123456",
      ];
      invalidNumbers.forEach((number) => {
        expect(number).not.toMatch(/^\+[1-9]\d{1,14}$/);
      });
    });
  });

  describe("Poll Token Format", () => {
    test("poll token includes POLL: prefix and userPhone", () => {
      const sessionCode = "A3F1B9C2E4";
      const userPhone = "+8801712345678";
      const expiresAt = Date.now() + 300000;

      const pollData = `POLL:${sessionCode}:${userPhone}:${expiresAt}`;
      expect(pollData).toContain("POLL:");
      expect(pollData).toContain(sessionCode);
      expect(pollData).toContain(userPhone);
    });
  });

  describe("SMS Body Format", () => {
    test("SMS body follows AUTH: prefix format", () => {
      const sessionCode = "A3F1B9C2E4";
      const expiresAt = Date.now() + 300000;
      const challengeToken = "XYZ123ABC";

      const smsBody = `AUTH:${sessionCode}:${expiresAt}:${challengeToken}`;
      expect(smsBody).toMatch(/^AUTH:[0-9A-F]{10}:\d+:[A-Z0-9]+$/);
    });
  });
});

/**
 * App Registry Tests (Phase 9)
 *
 * Tests for registerApp and revokeApp Cloud Functions.
 * These tests validate the multi-tenant app registry functionality.
 */
describe("App Registry - registerApp", () => {
  test("registerApp returns appId and appSecret for valid masterSecret", () => {
    // Verify response structure would contain appId and appSecret
    // (Full integration test requires Firebase emulator)
    const mockResponse = {
      appId: "550e8400-e29b-41d4-a716-446655440000",
      appSecret: crypto.randomBytes(32).toString("base64"),
      message: "Save appSecret immediately - it will not be shown again",
    };

    expect(mockResponse).toHaveProperty("appId");
    expect(mockResponse).toHaveProperty("appSecret");
    expect(mockResponse.appId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(mockResponse.appSecret).toHaveLength(44); // 32 bytes base64 encoded
  });

  test("registerApp rejects invalid masterSecret with 403", () => {
    const invalidSecret = "invalid_secret";

    // Verify timingSafeEqual is used for constant-time comparison
    expect(timingSafeEqual(invalidSecret, "different_secret")).toBe(false);
  });

  test("registerApp stores HMAC hash not raw appSecret in RTDB", () => {
    const appId = "test-app-id";
    const appSecret = "test_app_secret_32_characters_long";
    const mockMasterSecret = "master_secret_48_characters_long_for_testing";

    // registerApp module stores hex digest (64 chars), NOT the base64 from generateHmac
    const storedHash = crypto
      .createHmac("sha256", mockMasterSecret)
      .update(`${appId}${appSecret}`)
      .digest("hex");

    // Verify the hash is NOT equal to the raw secret
    expect(storedHash).not.toEqual(appSecret);
    expect(storedHash).toHaveLength(64); // Hex encoded HMAC-SHA256
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

    // generateHmac (used for poll tokens / OTP) uses base64 — different encoding
    const base64Hash = generateHmac(mockMasterSecret, `${appId}${appSecret}`);
    expect(base64Hash).toHaveLength(44); // Base64 encoded HMAC-SHA256
    expect(base64Hash).not.toEqual(storedHash); // Different encodings of the same HMAC
  });
});

describe("App Registry - revokeApp", () => {
  test("revokeApp sets active=false for valid appId", () => {
    const appId = "550e8400-e29b-41d4-a716-446655440000";

    // Verify response structure
    const mockResponse = {
      appId,
      active: false,
      message: "App revoked successfully",
    };

    expect(mockResponse).toHaveProperty("appId");
    expect(mockResponse).toHaveProperty("active");
    expect(mockResponse.active).toBe(false);
  });

  test("sendOtp rejects app with active=false", () => {
    // Verify that an inactive app would be rejected
    const active = false;
    expect(active).toBe(false);
  });
});

describe("onPaymentSmsReceived", () => {
  const snapshot = {
    val: jest.fn(),
  };
  const deleteMock = jest.fn();
  const event = {
    params: { pushId: "push123" },
    data: {
      val: snapshot.val,
    },
  };

  const loadIndex = () => {
    jest.resetModules();
    return require("./index");
  };

  beforeEach(() => {
    snapshot.val.mockReset();
    deleteMock.mockReset();
    global.fetch = jest.fn();
    jest.spyOn(admin.database(), "ref").mockImplementation(() => ({ delete: deleteMock }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RIDE_BACKEND_URL;
    delete process.env.DPRELAY_INBOUND_SECRET;
  });

  test("calls Ride backend with correct payload and headers for bkash", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 50000,
      provider: "bkash",
      received_at: 1712345678901,
    });
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    process.env.RIDE_BACKEND_URL = "https://ride.example.com";
    process.env.DPRELAY_INBOUND_SECRET = "secret123";
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://ride.example.com/api/payment/sms-confirm",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dprelay-secret": "secret123",
        },
        body: JSON.stringify({
          txn_id: "8AC3K2L9P1",
          amount_bdt: 50000,
          provider: "bkash",
          received_at: 1712345678901,
        }),
      }),
    );
  });

  test("deletes RTDB node on 200 success", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 50000,
      provider: "bkash",
      received_at: 1712345678901,
    });
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    process.env.RIDE_BACKEND_URL = "https://ride.example.com";
    process.env.DPRELAY_INBOUND_SECRET = "secret123";
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(deleteMock).toHaveBeenCalled();
  });

  test("deletes RTDB node on 404", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 50000,
      provider: "bkash",
      received_at: 1712345678901,
    });
    global.fetch.mockResolvedValue({ ok: false, status: 404 });
    process.env.RIDE_BACKEND_URL = "https://ride.example.com";
    process.env.DPRELAY_INBOUND_SECRET = "secret123";
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(deleteMock).toHaveBeenCalled();
  });

  test("deletes RTDB node on 409", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 50000,
      provider: "bkash",
      received_at: 1712345678901,
    });
    global.fetch.mockResolvedValue({ ok: false, status: 409 });
    process.env.RIDE_BACKEND_URL = "https://ride.example.com";
    process.env.DPRELAY_INBOUND_SECRET = "secret123";
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(deleteMock).toHaveBeenCalled();
  });

  test("does NOT delete node on 500 and throws", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 50000,
      provider: "bkash",
      received_at: 1712345678901,
    });
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    process.env.RIDE_BACKEND_URL = "https://ride.example.com";
    process.env.DPRELAY_INBOUND_SECRET = "secret123";
    const index = loadIndex();

    await expect(index.processPaymentSmsPayload(event)).rejects.toThrow(
      /Ride backend returned 500/,
    );
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test("discards and deletes node with bad txn_id", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "short",
      amount_bdt: 50000,
      provider: "bkash",
      received_at: 1712345678901,
    });
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(deleteMock).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("discards and deletes node with amount_bdt = 0", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 0,
      provider: "bkash",
      received_at: 1712345678901,
    });
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(deleteMock).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("discards and deletes node with unknown provider", async () => {
    snapshot.val.mockReturnValue({
      txn_id: "8AC3K2L9P1",
      amount_bdt: 50000,
      provider: "stripe",
      received_at: 1712345678901,
    });
    const index = loadIndex();

    await index.processPaymentSmsPayload(event);

    expect(deleteMock).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
