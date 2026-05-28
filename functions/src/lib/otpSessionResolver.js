/**
 * Resolves an OTP session record from supported storage locations.
 *
 * Resolution order:
 * 1. Exact lookup in otp_requests/{sessionId}
 * 2. Exact lookup in legacy otp_sessions/{sessionId}
 * 3. Prefix lookup in otp_requests when caller sends an 8-char short id
 *    (must resolve to exactly one record for the same appId)
 *
 * @param {object} db Firebase RTDB instance.
 * @param {string} rawSessionId Session id provided by caller.
 * @param {string} appId App id provided by caller.
 * @returns {Promise<{sessionPath: string, sessionKey: string, sessionRef: object, session: object}|null>}
 */
async function resolveOtpSessionRecord(db, rawSessionId, appId) {
  const sessionId = String(rawSessionId || "").trim();
  if (!sessionId) {
    return null;
  }

  const exactRef = db.ref(`otp_requests/${sessionId}`);
  const exactSnapshot = await exactRef.once("value");
  if (exactSnapshot.exists()) {
    return {
      sessionPath: "otp_requests",
      sessionKey: sessionId,
      sessionRef: exactRef,
      session: exactSnapshot.val(),
    };
  }

  const legacyRef = db.ref(`otp_sessions/${sessionId}`);
  const legacySnapshot = await legacyRef.once("value");
  if (legacySnapshot.exists()) {
    return {
      sessionPath: "otp_sessions",
      sessionKey: sessionId,
      sessionRef: legacyRef,
      session: legacySnapshot.val(),
    };
  }

  // Compatibility fallback for clients that still send only the short id.
  if (!/^[a-f0-9]{8}$/i.test(sessionId)) {
    return null;
  }

  const prefixSnapshot = await db
    .ref("otp_requests")
    .orderByKey()
    .startAt(sessionId)
    .endAt(`${sessionId}\uf8ff`)
    .once("value");

  if (!prefixSnapshot.exists()) {
    return null;
  }

  const candidates = [];
  prefixSnapshot.forEach((childSnapshot) => {
    const candidate = childSnapshot.val();
    if (candidate && candidate.appId === appId) {
      candidates.push({
        sessionKey: childSnapshot.key,
        session: candidate,
      });
    }
  });

  if (candidates.length !== 1) {
    return null;
  }

  const resolved = candidates[0];
  return {
    sessionPath: "otp_requests",
    sessionKey: resolved.sessionKey,
    sessionRef: db.ref(`otp_requests/${resolved.sessionKey}`),
    session: resolved.session,
  };
}

module.exports = {
  resolveOtpSessionRecord,
};