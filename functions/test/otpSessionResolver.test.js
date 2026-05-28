const { resolveOtpSessionRecord } = require("../src/lib/otpSessionResolver");

function createSnapshot(value, key = null) {
  return {
    key,
    exists() {
      return value !== null && value !== undefined;
    },
    val() {
      return value;
    },
    forEach(callback) {
      if (!value || typeof value !== "object") {
        return false;
      }

      for (const [childKey, childVal] of Object.entries(value)) {
        const shouldStop = callback(createSnapshot(childVal, childKey));
        if (shouldStop === true) {
          return true;
        }
      }
      return false;
    },
  };
}

function getByPath(tree, path) {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean);
  let current = tree;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function createMockDb(state) {
  const makeRef = (path) => {
    const basePath = String(path || "");

    return {
      once: async () => createSnapshot(getByPath(state, basePath)),
      child(subPath) {
        return makeRef(`${basePath}/${subPath}`);
      },
      orderByKey() {
        const query = {
          _startAt: "",
          _endAt: "\uf8ff",
          _limit: Number.MAX_SAFE_INTEGER,
          startAt(v) {
            this._startAt = v;
            return this;
          },
          endAt(v) {
            this._endAt = v;
            return this;
          },
          limitToFirst(v) {
            this._limit = v;
            return this;
          },
          async once() {
            const node = getByPath(state, basePath) || {};
            const filtered = Object.keys(node)
              .filter((key) => key >= this._startAt && key <= this._endAt)
              .sort()
              .slice(0, this._limit)
              .reduce((acc, key) => {
                acc[key] = node[key];
                return acc;
              }, {});

            return createSnapshot(
              Object.keys(filtered).length > 0 ? filtered : null,
            );
          },
        };
        return query;
      },
    };
  };

  return {
    ref(path) {
      return makeRef(path);
    },
  };
}

describe("resolveOtpSessionRecord", () => {
  test("resolves exact match from otp_requests", async () => {
    const db = createMockDb({
      otp_requests: {
        "abcd1234-1111-2222-3333-444455556666": { appId: "app-1" },
      },
    });

    const result = await resolveOtpSessionRecord(
      db,
      "abcd1234-1111-2222-3333-444455556666",
      "app-1",
    );

    expect(result).not.toBeNull();
    expect(result.sessionPath).toBe("otp_requests");
    expect(result.sessionKey).toBe("abcd1234-1111-2222-3333-444455556666");
    expect(result.session.appId).toBe("app-1");
  });

  test("resolves exact match from legacy otp_sessions", async () => {
    const db = createMockDb({
      otp_sessions: {
        legacy123: { appId: "app-legacy" },
      },
    });

    const result = await resolveOtpSessionRecord(db, "legacy123", "app-legacy");

    expect(result).not.toBeNull();
    expect(result.sessionPath).toBe("otp_sessions");
    expect(result.sessionKey).toBe("legacy123");
    expect(result.session.appId).toBe("app-legacy");
  });

  test("resolves short id by unique prefix match for same appId", async () => {
    const db = createMockDb({
      otp_requests: {
        "3e56f39b-1111-2222-3333-aaaaaaaabbbb": { appId: "app-1" },
      },
    });

    const result = await resolveOtpSessionRecord(db, "3e56f39b", "app-1");

    expect(result).not.toBeNull();
    expect(result.sessionPath).toBe("otp_requests");
    expect(result.sessionKey).toBe("3e56f39b-1111-2222-3333-aaaaaaaabbbb");
  });

  test("returns null when short id prefix is ambiguous", async () => {
    const db = createMockDb({
      otp_requests: {
        "3e56f39b-1111-2222-3333-aaaaaaaabbbb": { appId: "app-1" },
        "3e56f39b-9999-8888-7777-ccccccccdddd": { appId: "app-1" },
      },
    });

    const result = await resolveOtpSessionRecord(db, "3e56f39b", "app-1");

    expect(result).toBeNull();
  });

  test("returns null when short id resolves only to different appId", async () => {
    const db = createMockDb({
      otp_requests: {
        "3e56f39b-1111-2222-3333-aaaaaaaabbbb": { appId: "app-2" },
      },
    });

    const result = await resolveOtpSessionRecord(db, "3e56f39b", "app-1");

    expect(result).toBeNull();
  });
});