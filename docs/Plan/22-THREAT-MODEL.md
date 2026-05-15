<!--
AI: This document analyzes security threats and mitigations. All threats must have mitigations implemented before production.
Read first: 01-PRD.md (security requirements), 04-ADR.md (security decisions), 08-Security-Maintenance.md
You must: Implement every mitigation listed. Assume attackers have full knowledge of the system.
You must not: Dismiss a threat without implementing its mitigation. Assume security through obscurity.
Human reviews this: YES — threat model must be approved by security lead before production.
-->

# Threat Model
**Project:** Authenticator

## Overview

This document identifies security threats to the Authenticator phone verification system and their mitigations. Analysis follows the STRIDE methodology:
- **S**poofing
- **T**ampering
- **R**epudiation
- **I**nformation Disclosure
- **D**enial of Service
- **E**levation of Privilege

---

## Threat Actors

| Actor | Capabilities | Motivation |
|-------|-------------|------------|
| External Attacker | No system secrets; network access | Bypass verification for fraud |
| Malicious User | Legitimate phone number; no secrets | Verify arbitrary phone numbers |
| Compromised Client Device | App binary, session data, ability to call public endpoints | Abuse verification flow, but not mint valid server-issued challenges |
| Insider (Developer) | Access to Firebase Console, secrets | Data access, unauthorized modifications |
| Nation-State | SS7 access, carrier-level attacks | Mass surveillance, interception |
| OEM/Manufacturer | Device-level control | N/A (trusted in this model) |

---

## Threat Inventory

### 1. Spoofing: SMS Interception (SS7/SIM Swap)
**Description:** Attacker intercepts SMS in transit via SS7 network vulnerabilities or SIM swapping.

**Impact:** Attacker could receive verification SMS intended for victim.

**Risk Assessment:**
- Likelihood: Medium (SS7 attacks require sophistication; SIM swaps require social engineering)
- Impact: High (verification bypass)

**Mitigation (Implemented):**
1. **Server-issued challenge:** SMS payload contains a server-minted challenge token bound to `sessionCode`, `userPhone`, and `expiresAt`
2. **Sender matching:** Cloud Function verifies SMS sender matches claimed phone number
3. **Atomic delete:** Entry deleted after verification; cannot be replayed

**Residual Risk:** Low. Attacker would need to:
- Intercept SMS within a 5-minute window
- Match victim's phone number exactly
- Complete verification before legitimate user

**Verification:**
```kotlin
// Test: Intercepted SMS cannot be replayed
@Test
fun `interceptedSmsCannotBeReused()` {
  // Complete verification
  // Attempt replay with same sessionCode
  // Verify: pending (entry deleted)
}
```

---

### 2. Tampering: Database Entry Manipulation
**Description:** Attacker modifies `/verification_requests/{sessionCode}` or its `receipt` child to forge verification.

**Impact:** False verification of arbitrary phone number.

**Risk Assessment:**
- Likelihood: Low (requires RTDB write access)
- Impact: High

**Mitigation (Implemented):**
1. **RTDB Security Rules:** Only identities with `auth.token.role == 'authenticator'` can write `receipt` and `health` data
2. **Challenge verification:** Cloud Function recomputes the expected challenge token from server-side request state
3. **Field validation:** Rules reject writes missing `receivedAt`, `sender`, or `challengeToken`

**Code Reference:**
```javascript
// Cloud Function challenge verification
const expectedChallenge = computeChallenge(sessionCode, dbEntry.userPhone, dbEntry.expiresAt);
if (!timingSafeEqual(Buffer.from(dbEntry.receipt.challengeToken), expectedChallenge)) {
  return res.status(403).json({ error: 'invalid_challenge' });
}
```

**Residual Risk:** Low. Attacker would need to compromise the authenticator-role device identity or the dedicated phone itself.

---

### 3. Replay Attack: Reusing Valid Session Code
**Description:** Attacker captures valid session code and retries verification.

**Impact:** Multiple verifications with same proof.

**Risk Assessment:**
- Likelihood: Medium (session codes visible in SMS)
- Impact: Medium

**Mitigation (Implemented):**
1. **Atomic delete:** Entry removed from RTDB on successful verification
2. **Timestamp expiration:** Entries auto-deleted after 24 hours
3. **Session code uniqueness:** 10 hex chars = 1 trillion combinations

**Test Case:**
```kotlin
@Test
fun `sessionCodeCannotBeReused()` {
  val sessionCode = "A1B2C3D4E5"
  // First verification succeeds
  verify(sessionCode) // returns verified: true
  // Second attempt with same code
  verify(sessionCode) // returns pending (entry not found)
}
```

**Residual Risk:** None. Replay is prevented by design.

---

### 4. Information Disclosure: Secret Exposure
**Description:** A server-only secret or authenticator bootstrap secret leaks via source control, logs, or packaging mistakes.

**Impact:** Attacker could mint challenges server-side or enroll a rogue authenticator device.

**Risk Assessment:**
- Likelihood: Medium (developer error)
- Impact: Critical

**Mitigation (Implemented):**
1. **Firebase Secrets Manager:** `VERIFICATION_SIGNING_SECRET`, `AUTHENTICATOR_ENROLLMENT_SECRET`, and `HEALTH_ADMIN_SECRET` stored securely
2. **Role separation:** Public clients hold no long-lived verification signing secret
3. **Enrollment secret NOT in BuildConfig:** The `AUTHENTICATOR_ENROLLMENT_SECRET` must be supplied at runtime (prompted on first run, injected via ADB, or loaded from a file excluded from source control). Compiling it into the APK is prohibited — see T-09.
4. **No URL parameters:** POST body only; no secrets in query strings
5. **No SMS body logging:** Only receipt metadata logged (never raw secret)
6. **Git pre-commit hooks:** Scan for secrets before commit

**Pre-commit Hook:**
```bash
#!/bin/bash
if git diff --cached | grep -iE '(secret|password|key)\s*[:=]\s*["\'][^"\']{20,}'; then
  echo "Potential secret detected in commit!"
  exit 1
fi
```

**Residual Risk:** Low. Depends on developer discipline with BuildConfig.

---

### 5. Denial of Service: Brute Force Discovery
**Description:** Attacker floods Cloud Function with random session codes.

**Impact:** Resource exhaustion, legitimate users blocked.

**Risk Assessment:**
- Likelihood: High (easy to automate)
- Impact: Medium

**Mitigation (Implemented):**
1. **Rate limiting:** 30 requests/minute per IP
2. **Session code entropy:** 10 hex chars = 1 in 1 trillion chance
3. **Firebase free tier limits:** Natural throttling at scale
4. **Rate limit headers:** Clients can adapt before hitting limit

**Rate Limit Implementation:**
```javascript
const rateLimiter = new Map(); // IP -> {count, resetTime}

function checkRateLimit(ip) {
  const now = Date.now();
  const limit = rateLimiter.get(ip);
  
  if (!limit || now > limit.resetTime) {
    rateLimiter.set(ip, { count: 1, resetTime: now + 60000 });
    return true;
  }
  
  if (limit.count >= 30) return false;
  limit.count++;
  return true;
}
```

**Residual Risk:** Low. Single IP limited; distributed attacks would hit Firebase limits.

**Production note:** For multi-instance deployments, replace in-memory per-instance tracking with a shared counter in RTDB or Firestore using transaction-safe increments and TTL entries.

---

### 6. Elevation of Privilege: Unauthorized RTDB Access
**Description:** Attacker gains write access to RTDB without the authenticator role.

**Impact:** Forge verification entries.

**Risk Assessment:**
- Likelihood: Low (requires Firebase auth bypass)
- Impact: Critical

**Mitigation (Implemented):**
1. **Authenticator-role custom auth required:** Device writes require `auth.token.role == 'authenticator'`
2. **Security rules validation:** Public clients cannot write verification state
3. **Field validation:** Rules validate data structure
4. **No admin SDK on device:** Admin SDK (bypasses rules) only in Cloud Functions

**RTDB Security Rules:**
```json
{
  "rules": {
    "verification_requests": {
      "$sessionCode": {
        "receipt": {
          ".write": "auth != null && auth.token.role == 'authenticator' && newData.hasChildren(['receivedAt', 'sender', 'challengeToken'])"
        }
      }
    }
  }
}
```

**Residual Risk:** Negligible. Would require Firebase auth vulnerability.

---

### 7. Timing Attack: HMAC Comparison Side-Channel
**Description:** Attacker measures response time to guess HMAC byte-by-byte.

**Impact:** HMAC forgery through statistical analysis.

**Risk Assessment:**
- Likelihood: Low (requires precise timing, many samples)
- Impact: Medium

**Mitigation (Implemented):**
1. **Constant-time comparison:** `crypto.timingSafeEqual()` in Node.js
2. **Kotlin constant-time:** `AuthCrypto.constantTimeEquals()`
3. **No early returns:** Comparison always checks all bytes

**Kotlin Implementation:**
```kotlin
fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
  if (a.size != b.size) return false
  var result = 0
  for (i in a.indices) {
    result = result or (a[i].toInt() xor b[i].toInt())
  }
  return result == 0
}
```

**Test:**
```kotlin
@Test
fun `hmacComparisonIsConstantTime()` {
  val valid = generateHmac("test")
  val invalid = ByteArray(32) { 0 }
  
  val validTime = measureTime { constantTimeEquals(valid, valid) }
  val invalidTime = measureTime { constantTimeEquals(valid, invalid) }
  
  assert(abs(validTime - invalidTime) < 10.milliseconds)
}
```

**Residual Risk:** Negligible.

---

### 8. Clock Skew Attack: Exploiting Time Tolerance
**Description:** Attacker manipulates device clock to extend HMAC validity.

**Impact:** Extended window for replay attacks.

**Risk Assessment:**
- Likelihood: Low (requires device compromise)
- Impact: Low

**Mitigation (Implemented):**
1. **5-minute tolerance:** Narrow enough to limit replay while remaining practical for Bangladesh connectivity conditions
2. **NTP enforcement:** Both devices use automatic time sync
3. **Server-side timestamp validation:** Cloud Function uses server time
4. **Clock skew alerts:** Monitor for devices with >1min skew

**Residual Risk:** Negligible. Requires device-level compromise.

---

### 9. Information Disclosure: Enrollment Secret Compiled into APK
**Description:** `AUTHENTICATOR_ENROLLMENT_SECRET` is compiled into the authenticator APK as a `BuildConfig` constant. Any developer or attacker who decompiles the APK with standard tools (apktool, jadx) can read the enrollment secret in plaintext.

**Impact:** Attacker can call `POST /v4/registerAuthenticator` with the enrollment secret, obtain a Firebase custom token with `role=authenticator`, and write forged verification receipts or health data to RTDB.

**Risk Assessment:**
- Likelihood: High (APK decompilation is trivial)
- Impact: Critical (grants authenticator-role RTDB write access)

**Mitigation (Required before production):**
1. **Do not compile secret into APK.** Remove `buildConfigField("AUTHENTICATOR_ENROLLMENT_SECRET", ...)` from `build.gradle`.
2. **Supply at runtime via one of:**
   - First-run prompt stored in Android `EncryptedSharedPreferences`
   - ADB environment injection on the dedicated device
   - A secrets file (`authenticator.secrets.properties`) excluded from source control via `.gitignore`
3. **Rotation:** Treat the enrollment secret as a short-lived credential; rotate it if the APK is distributed outside the development team.
4. **Monitor enrollments:** Log `registerAuthenticator` calls; alert on more than one unique device ID registering.

**Residual Risk:** Low if runtime supply is implemented. The enrollment secret grants only authenticator-role write access — it does not expose `VERIFICATION_SIGNING_SECRET` or allow challenge minting.

---

### 10. Tampering: Carrier Phone Number Format Mismatch
**Description:** Android `SmsMessage.getOriginatingAddress()` may return a number without a country-code prefix when the carrier omits it (e.g. `01712345678` instead of `+8801712345678`). If `SmsReceiver` writes this raw value as `sender`, the Cloud Function's `receipt.sender == userPhone` check will always fail with `mismatch` even for a legitimate SMS.

**Impact:** Legitimate verifications silently fail. The user and operator see `mismatch` with no explanation. The system is effectively broken for any carrier that omits the `+880` prefix.

**Risk Assessment:**
- Likelihood: High (observed on Bangladeshi carriers in testing)
- Impact: High (system-wide verification failure for affected carrier)

**Mitigation (Required before production):**
1. **Normalise in `SmsReceiver` before any comparison or RTDB write.**
   ```kotlin
   fun normalizeToE164(raw: String, defaultCountryCode: String = "+880"): String {
     if (raw.startsWith("+")) return raw
     if (raw.startsWith("880")) return "+$raw"
     if (raw.startsWith("0")) return "$defaultCountryCode${raw.substring(1)}"
     return raw // write as-is so checkAuth returns mismatch, not pending
   }
   ```
2. **Unit-test with at least four formats:** `+8801712345678`, `8801712345678`, `01712345678`, and a short unrecognisable string.
3. **Non-normalisable addresses** must still be written to RTDB (so `checkAuth` returns `mismatch` rather than `pending` hanging until expiry).

**Residual Risk:** Low once normalisation is implemented. Carriers that use short codes or alpha-numeric sender IDs are not supported and will produce an expected `mismatch`.

---

### 11. Information Disclosure / Tampering: Unauthorized Device Enrollment

**Threat ID:** T-11
**STRIDE category:** Information Disclosure, Tampering
**Component:** Cloud Functions (`registerAuthenticator`), Firebase Auth

**Description:** An attacker who obtains the `AUTHENTICATOR_ENROLLMENT_SECRET` (e.g., via APK decompilation before ADR-016 was applied, or via physical access to the dedicated phone) can register an additional device as a legitimate authenticator. That rogue device can then write forged receipts for any verification session before the real authenticator phone responds, causing arbitrary phone numbers to be verified.

**Likelihood:** Low (secret is not in APK; enrollment requires physical first-run access)
**Impact:** High (arbitrary phone number verified → authentication bypassed)
**Risk Level:** Medium

**Mitigations:**
1. **Rotate immediately** if the enrollment secret is believed to be compromised (see 15-RUNBOOK-DEPLOY.md Panic Button section).
2. **Audit logging (post-MVP):** Log every `POST /v4/registerAuthenticator` call — success and failure — with timestamp, source IP, and `androidId`. Write to `/audit/registrations/{pushId}`. Alert if more than one distinct device registers within a rolling 5-minute window.
3. **Revoke compromised device:** Delete the Firebase Auth UID corresponding to the rogue `androidId` (see RUNBOOK Step 1).
4. **RTDB rule defence:** RTDB rules enforce `auth.token.role === 'authenticator'`; a rogue device not yet enrolled cannot write receipts.

**Residual Risk:** Low given secret is runtime-only (ADR-016) and the rotation procedure is documented. Becomes negligible once audit logging with alerting is implemented.

---

| ID | Threat | Likelihood | Impact | Risk Level | Mitigation Status |
|----|--------|-----------|--------|------------|-------------------|
| T-01 | SMS Interception (SS7/SIM swap) | Medium | High | Medium | Implemented |
| T-02 | Database Entry Manipulation | Low | High | Low | Implemented |
| T-03 | Replay Attack | Medium | Medium | Low | Implemented |
| T-04 | Shared Secret Exposure | Medium | Critical | Medium | Implemented |
| T-05 | Brute Force DoS | High | Medium | Low | Implemented |
| T-06 | Unauthorized RTDB Access | Low | Critical | Low | Implemented |
| T-07 | Timing Attack | Low | Medium | Low | Implemented |
| T-08 | Clock Skew Exploitation | Low | Low | Low | Implemented |
| T-09 | Enrollment Secret in APK (BuildConfig) | High | Critical | **High** | **Not implemented — pre-production blocker** |
| T-10 | Carrier Number Format Mismatch | High | High | **High** | **Not implemented — pre-production blocker** |
| T-11 | Unauthorized Device Enrollment | Low | High | Medium | Partial — rotation procedure exists; audit logging not yet implemented |

---

## Attack Scenarios

### Scenario 1: Attacker with SS7 Access
1. **Attacker intercepts SMS** containing `AUTH:{sessionCode}:{expiresAt}:{challengeToken}`
2. **Attacker has until `expiresAt`** to complete verification before the request expires
3. **Cloud Function checks:** Does SMS sender match claimed phone number?
   - If attacker uses their own phone: Mismatch -> verification fails
   - If attacker claims intercepted number: Match -> verification succeeds
4. **But:** Attacker needed to know victim's phone number in advance and trigger the verification

**Conclusion:** Attack possible only if attacker controls victim's phone number or can trigger verifications at will.

### Scenario 2: Compromised Authenticator Phone
1. **Attacker gains physical access** to dedicated phone
2. **Attacker can:** Read the authenticator bootstrap secret, obtain authenticator-role Firebase tokens, and forge receipts from that device context
3. **Attacker cannot:** Access the server-only verification signing secret from the public client path

**Conclusion:** Compromised phone allows local forgery but not public-client-wide compromise. Rotate the authenticator enrollment secret and re-enroll the dedicated phone immediately.

### Scenario 3: Insider Threat (Developer)
1. **Malicious developer** has Firebase Console access
2. **Developer can:** Read RTDB, modify Cloud Functions, see secret values
3. **Mitigation:** Separate staging/production Firebase projects; 2-person approval for production deploys

---

## Security Checklist

Before production release, verify:

- [ ] All threat mitigations implemented and tested
- [ ] RTDB security rules enforce `auth.token.role == 'authenticator'` for device writes
- [ ] HMAC comparison uses constant-time algorithm
- [ ] Rate limiting enabled (30 req/min)
- [ ] Atomic delete implemented (no replay possible)
- [ ] No secrets in source control (run secret scan)
- [ ] No secrets in URL parameters or logs
- [ ] TLS 1.3 enforced for all API calls
- [ ] **T-09:** `AUTHENTICATOR_ENROLLMENT_SECRET` is NOT present in APK as a `BuildConfig` constant
- [ ] **T-09:** Enrollment secret supplied at runtime via `EncryptedSharedPreferences`, ADB injection, or excluded secrets file
- [ ] **T-10:** `SmsReceiver.normalizeToE164()` implemented and 100% unit tested
- [ ] **T-10:** Normalization test passes for `+8801712345678`, `8801712345678`, `01712345678`, and unrecognised format
- [ ] **T-11:** Every call to `POST /v4/registerAuthenticator` (success or failure) is logged with timestamp, source IP, and device ID
- [ ] **T-11:** Alert triggers if more than one distinct device registers within a 5-minute window
- [ ] **T-11:** Panic button procedure tested on staging (see 15-RUNBOOK-DEPLOY.md)
- [ ] Firebase App Check enabled (post-MVP)
- [ ] Security audit completed by third party (optional)

---

## Penetration Testing Plan

### Scope
- Cloud Functions (`startVerification`, `checkAuth`, `registerAuthenticator`, `health`)
- Firebase RTDB rules
- Android app (authenticator and client)

### Test Cases
1. **Replay Attack:** Verify same session code cannot be used twice
2. **Brute Force:** Attempt 1000 verifications from single IP
3. **Secret Exposure:** Search source code for hardcoded secrets
4. **Timing Analysis:** Measure poll token and challenge token comparison times
5. **Auth Bypass:** Attempt RTDB write without authenticator-role Firebase auth
6. **Clock Manipulation:** Set device clock 10 minutes ahead

### Success Criteria
- All replay attacks fail
- Rate limit enforced at exactly 30 requests
- No secrets found in code
- Timing variance < 10ms across all attempts
- All unauthorized writes rejected
- Clock skew > 5min causes rejection

---

## Residual Risks & Acceptance

| Risk | Mitigation | Accepted By |
|------|-----------|-------------|
| SS7 interception | Server-issued challenge, sender matching | Product Owner |
| OEM service killing | Triple keep-alive | Product Owner |
| Firebase quota limits | Capacity planning | Product Owner |
| Device hardware failure | Manual backup procedures | Product Owner |

---

## Security Contacts

| Role | Contact | Escalation |
|------|---------|------------|
| Security Lead | security@company.com | Team Lead |
| On-Call Engineer | oncall@company.com | Security Lead |
| Firebase Support | firebase.google.com/support | N/A |
