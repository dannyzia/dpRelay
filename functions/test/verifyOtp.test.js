process.env.VERIFICATION_SIGNING_SECRET =
  'test_verification_signing_secret_32_chars';

const mockRootUpdate = jest.fn();
const mockDb = {
  ref: jest.fn(() => ({
    update: mockRootUpdate,
  })),
};
const mockAuth = {
  createCustomToken: jest.fn(),
};
const mockFirestore = {
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({
      get: jest.fn(),
      set: jest.fn(),
      update: jest.fn(),
      add: jest.fn(),
    })),
  })),
  runTransaction: jest.fn(),
};
const mockLogger = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_options, handler) => handler,
  onRequest: (_options, handler) => handler,
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_options, handler) => handler,
}));

jest.mock('firebase-functions/logger', () => mockLogger);

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  database: Object.assign(() => mockDb, {
    ServerValue: {
      TIMESTAMP: {'.sv': 'timestamp'},
    },
  }),
  auth: () => mockAuth,
  firestore: () => mockFirestore,
  credential: {
    cert: jest.fn(),
  },
}));

jest.mock('../src/lib/otpSessionResolver', () => ({
  resolveOtpSessionRecord: jest.fn(),
}));

const {resolveOtpSessionRecord} = require('../src/lib/otpSessionResolver');
const {generateHmac, verifyOtp} = require('../index');

function createResponse() {
  const response = {
    body: undefined,
    headers: {},
    statusCode: 200,
    json: jest.fn((payload) => {
      response.body = payload;
      return response;
    }),
    setHeader: jest.fn((name, value) => {
      response.headers[name] = value;
    }),
    status: jest.fn((code) => {
      response.statusCode = code;
      return response;
    }),
  };

  return response;
}

describe('verifyOtp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.ref.mockImplementation((path) => {
      if (!path) {
        return {
          update: mockRootUpdate,
        };
      }

      return {
        once: jest.fn(),
        remove: jest.fn(),
        transaction: jest.fn(),
        update: jest.fn(),
      };
    });
  });

  test('falls back to re-read on null-start abort and returns mismatch without deleting the session', async () => {
    const sessionKey = 'session-null-start';
    const session = {
      appId: 'app-1',
      attempts: 0,
      expiresAt: Date.now() + 60_000,
      hashedOtp: generateHmac(
        process.env.VERIFICATION_SIGNING_SECRET,
        `${sessionKey}111111`,
      ),
      locked: false,
      phoneNumber: '+8801712345678',
    };
    const setAttempts = jest.fn();
    const sessionRef = {
      child: jest.fn(() => ({
        set: setAttempts,
      })),
      once: jest.fn().mockResolvedValue({
        exists: () => true,
        val: () => session,
      }),
      transaction: jest.fn().mockResolvedValue({
        committed: false,
        snapshot: null,
      }),
    };

    resolveOtpSessionRecord.mockResolvedValue({
      sessionPath: 'otp_requests',
      sessionKey,
      sessionRef,
      session,
    });

    const response = createResponse();

    await verifyOtp(
      {
        body: {
          appId: 'app-1',
          otp: '000000',
          sessionId: sessionKey,
        },
        ip: '127.0.0.1',
        method: 'POST',
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      verified: false,
      reason: 'mismatch',
    });
    expect(sessionRef.transaction).toHaveBeenCalledTimes(1);
    expect(sessionRef.once).toHaveBeenCalledWith('value');
    expect(sessionRef.child).toHaveBeenCalledWith('attempts');
    expect(setAttempts).toHaveBeenCalledWith(1);
    expect(mockRootUpdate).not.toHaveBeenCalled();
  });

  test('returns not_found when the session is genuinely gone after a transaction abort', async () => {
    const sessionRef = {
      child: jest.fn(),
      once: jest.fn().mockResolvedValue({
        exists: () => false,
      }),
      transaction: jest.fn().mockResolvedValue({
        committed: false,
        snapshot: null,
      }),
    };

    resolveOtpSessionRecord.mockResolvedValue({
      sessionPath: 'otp_requests',
      sessionKey: 'session-missing',
      sessionRef,
      session: {
        appId: 'app-1',
        attempts: 0,
        expiresAt: Date.now() + 60_000,
        hashedOtp: 'irrelevant',
        locked: false,
      },
    });

    const response = createResponse();

    await verifyOtp(
      {
        body: {
          appId: 'app-1',
          otp: '000000',
          sessionId: 'session-missing',
        },
        ip: '127.0.0.1',
        method: 'POST',
      },
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      verified: false,
      reason: 'not_found',
    });
    expect(sessionRef.child).not.toHaveBeenCalled();
    expect(mockRootUpdate).not.toHaveBeenCalled();
  });

  test('returns verified=true once from a matching success receipt when the live session is already gone', async () => {
    const sessionKey = 'session-replay';
    const otp = '654321';
    const removeReceipt = jest.fn();
    const receiptRef = {
      once: jest.fn().mockResolvedValue({
        exists: () => true,
        val: () => ({
          appId: 'app-1',
          expiresAt: Date.now() + 60_000,
          hashedOtp: generateHmac(
            process.env.VERIFICATION_SIGNING_SECRET,
            `${sessionKey}${otp}`,
          ),
          phoneNumber: '+8801712345678',
          replayAvailable: true,
        }),
      }),
      remove: removeReceipt,
      transaction: jest.fn().mockResolvedValue({
        committed: false,
        snapshot: null,
      }),
    };

    mockDb.ref.mockImplementation((path) => {
      if (!path) {
        return {
          update: mockRootUpdate,
        };
      }

      if (path === `otp_verify_receipts/${sessionKey}`) {
        return receiptRef;
      }

      return {
        once: jest.fn(),
        remove: jest.fn(),
        transaction: jest.fn(),
        update: jest.fn(),
      };
    });

    resolveOtpSessionRecord.mockResolvedValue(null);

    const response = createResponse();

    await verifyOtp(
      {
        body: {
          appId: 'app-1',
          otp,
          sessionId: sessionKey,
        },
        ip: '127.0.0.1',
        method: 'POST',
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      verified: true,
      phoneNumber: '+8801712345678',
    });
    expect(receiptRef.transaction).toHaveBeenCalledTimes(1);
    expect(receiptRef.once).toHaveBeenCalledWith('value');
    expect(removeReceipt).toHaveBeenCalledTimes(1);
  });

  test('does not reveal a consumed success receipt for the wrong OTP', async () => {
    const sessionKey = 'session-replay-miss';
    const receiptRef = {
      once: jest.fn().mockResolvedValue({
        exists: () => true,
        val: () => ({
          appId: 'app-1',
          expiresAt: Date.now() + 60_000,
          hashedOtp: generateHmac(
            process.env.VERIFICATION_SIGNING_SECRET,
            `${sessionKey}654321`,
          ),
          phoneNumber: '+8801712345678',
          replayAvailable: true,
        }),
      }),
      remove: jest.fn(),
      transaction: jest.fn().mockResolvedValue({
        committed: false,
        snapshot: null,
      }),
    };

    mockDb.ref.mockImplementation((path) => {
      if (!path) {
        return {
          update: mockRootUpdate,
        };
      }

      if (path === `otp_verify_receipts/${sessionKey}`) {
        return receiptRef;
      }

      return {
        once: jest.fn(),
        remove: jest.fn(),
        transaction: jest.fn(),
        update: jest.fn(),
      };
    });

    resolveOtpSessionRecord.mockResolvedValue(null);

    const response = createResponse();

    await verifyOtp(
      {
        body: {
          appId: 'app-1',
          otp: '000000',
          sessionId: sessionKey,
        },
        ip: '127.0.0.1',
        method: 'POST',
      },
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      verified: false,
      reason: 'not_found',
    });
    expect(receiptRef.remove).not.toHaveBeenCalled();
  });

  test('deletes the OTP session and pending_sms entry after a successful verify', async () => {
    const sessionKey = 'session-success';
    const otp = '654321';
    const session = {
      appId: 'app-1',
      attempts: 1,
      expiresAt: Date.now() + 60_000,
      hashedOtp: generateHmac(
        process.env.VERIFICATION_SIGNING_SECRET,
        `${sessionKey}${otp}`,
      ),
      locked: false,
      phoneNumber: '+8801712345678',
    };
    const sessionRef = {
      child: jest.fn(),
      transaction: jest.fn().mockResolvedValue({
        committed: true,
        snapshot: {
          exists: () => true,
          val: () => session,
        },
      }),
    };

    resolveOtpSessionRecord.mockResolvedValue({
      sessionPath: 'otp_requests',
      sessionKey,
      sessionRef,
      session: {
        ...session,
        attempts: 0,
      },
    });

    const response = createResponse();

    await verifyOtp(
      {
        body: {
          appId: 'app-1',
          otp,
          sessionId: sessionKey,
        },
        ip: '127.0.0.1',
        method: 'POST',
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      verified: true,
      phoneNumber: '+8801712345678',
    });
    expect(mockRootUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        [`otp_requests/${sessionKey}`]: null,
        [`pending_sms/${sessionKey}`]: null,
        [`otp_verify_receipts/${sessionKey}`]: {
          appId: 'app-1',
          expiresAt: session.expiresAt,
          hashedOtp: session.hashedOtp,
          phoneNumber: '+8801712345678',
          replayAvailable: true,
          verifiedAt: {'.sv': 'timestamp'},
        },
      }),
    );
  });
});