<!--
AI: This is the complete testing strategy. Every test listed must pass before production release.
Read first: 01-PRD.md (acceptance criteria), 06-API.md (API contract for testing), 14-DEV-CHECKLIST.yaml (authoritative AI checklist)
You must: Implement every test category. Maintain > 80% coverage for crypto/HMAC code.
You must not: Skip integration tests. Deploy without e2e verification passing.
Human reviews this: YES — test plan must be approved before development begins.
-->

# Test Plan
**Project:** Authenticator

## Overview
This document defines the complete testing strategy for the Authenticator phone verification system. All tests must pass before production deployment.

---

## Test environment setup

### Firebase Emulator Suite (required for all tests)
```bash
# 1. Install Firebase CLI
npm install -g firebase-tools

# 2. Initialize emulators (first time only)
firebase init emulators
# Select: Functions, Database, Auth
# Port defaults: Functions=5001, Database=9000, Auth=9099

# 3. Start emulators
firebase emulators:start --only functions,database,auth

# 4. Verify emulators running
curl http://localhost:5001/PhoneAuthService/us-central1/v4/startVerification
# Should return 405 (POST only)

# 5. Seed test data (optional)
firebase database:set /verification_requests/TESTCODE1234 test-data.json --project demo-test
```

### Test data fixture
```json
{
  "createdAt": 1712345678901,
  "expiresAt": 1712345978901,
  "userPhone": "+8801712345678",
  "receipt": {
    "receivedAt": 1712345680000,
    "sender": "+8801712345678",
    "challengeToken": "validChallengeTokenForTestPurposesOnly==",
    "device": "Test Device"
  }
}
```

### Android emulator SMS testing
```bash
# Send test SMS to Android emulator
adb emu sms send +8801712345678 "AUTH:TESTCODE12:1712345978901:testChallengeTokenBase64"

# Or via telnet:
telnet localhost 5554
sms send +8801712345678 AUTH:TESTCODE12:1712345678901:testSignatureBase64
```

### Environment variables for testing
| Variable | Test Value | Purpose |
|----------|-----------|---------|
| `VERIFICATION_SIGNING_SECRET` | `test-secret-do-not-use-in-production-32chars` | Test challenge/poll signing key |
| `AUTHENTICATOR_ENROLLMENT_SECRET` | `test-authenticator-enrollment-secret-32chars` | Test device enrollment secret |
| `CF_URL` | `http://10.0.2.2:5001/PhoneAuthService/us-central1` | Local emulator base URL |
| `FIREBASE_AUTH_EMULATOR_HOST` | `localhost:9099` | Auth emulator |
| `FIREBASE_DATABASE_EMULATOR_HOST` | `localhost:9000` | Database emulator |

---

## Unit Testing

### Coverage Requirements
| Module | Minimum Coverage | Critical Paths |
|--------|-----------------|----------------|
| AuthCrypto.kt | 100% | Session code generation, constant-time comparison |
| SmsReceiver.kt | 90% | SMS parsing, expiry validation, Firebase write |
| PhoneAuthHelper.kt | 85% | Request building, response parsing |
| Cloud Functions | 90% | All validation paths, error handling |

### AuthCrypto.kt Test Cases
```kotlin
@Test
fun `constantTimeEquals returns true for identical byte arrays`()

@Test
fun `constantTimeEquals returns false for different byte arrays`()

@Test
fun `constantTimeEquals takes constant time regardless of mismatch position`()

@Test
fun `generateSessionCode produces 10 uppercase hex characters`()

@Test
fun `validateExpiry accepts timestamps within 5 minute window`()

@Test
fun `validateExpiry rejects timestamps outside 5 minute window`()
```

### SmsReceiver.kt Test Cases
```kotlin
@Test
fun `extractSessionCode parses valid AUTH prefix SMS`()

@Test
fun `extractSessionCode returns null for non-AUTH SMS`()

@Test
fun `parseChallenge accepts valid AUTH payload`()

@Test
fun `parseChallenge rejects malformed payload`()

@Test
fun `parseChallenge rejects expired challenge`()

@Test
fun `onReceive ignores SMS without AUTH prefix`()

@Test
fun `onReceive does not log non-AUTH SMS body`()

@Test
fun `normalizeToE164 returns unchanged string for address with plus and country code`()

@Test
fun `normalizeToE164 prefixes plus880 for BD number without country code (e g 01712345678)`()

@Test
fun `normalizeToE164 prefixes plus for number with 880 but no plus`()

@Test
fun `normalizeToE164 returns original string unchanged when pattern is unrecognised (to surface mismatch rather than silent hang)`()

// Bangladesh carrier-specific formats observed in production
// Grameenphone: 017X, 013X
@Test
fun `normalizeToE164 handles Grameenphone 017X number without country code`()  // "01712345678" → "+8801712345678"

@Test
fun `normalizeToE164 handles Grameenphone 013X number without country code`()  // "01312345678" → "+8801312345678"

// Robi Axiata: 018X, 016X
@Test
fun `normalizeToE164 handles Robi 018X number without country code`()  // "01812345678" → "+8801812345678"

@Test
fun `normalizeToE164 handles Robi 016X number without country code`()  // "01612345678" → "+8801612345678"

// Banglalink: 019X, 014X
@Test
fun `normalizeToE164 handles Banglalink 019X number without country code`()  // "01912345678" → "+8801912345678"

@Test
fun `normalizeToE164 handles Banglalink 014X number without country code`()  // "01412345678" → "+8801412345678"

// Teletalk: 015X
@Test
fun `normalizeToE164 handles Teletalk 015X number without country code`()  // "01512345678" → "+8801512345678"

// Carrier strips country code but keeps IDD prefix (uncommon but observed)
@Test
fun `normalizeToE164 handles 880XXXXXXXXXX with leading 880 and no plus`()  // "8801712345678" → "+8801712345678"
```

### Cloud Functions Test Cases (Jest)
```javascript
describe('startVerification', () => {
  test('returns 405 for GET request', async () => {});
  test('returns 400 for missing userPhone', async () => {});
  test('returns 200 with sessionCode, smsBody, pollToken, dedicatedNumber, and expiresAt', async () => {});
  test('returns 429 when rate limit exceeded', async () => {});
});

describe('computeChallenge', () => {
  test('produces a Base64 string deterministically for the same inputs', async () => {});
  test('produces different output when sessionCode changes', async () => {});
  test('produces different output when userPhone changes', async () => {});
  test('produces different output when expiresAt changes', async () => {});
  test('does not equal computePollToken output for the same inputs (prefix distinguishes them)', async () => {});
});

describe('computePollToken', () => {
  test('produces a Base64 string deterministically for the same inputs', async () => {});
  test('produces different output when sessionCode changes', async () => {});
  test('result begins with expected HMAC of POLL-prefixed input', async () => {});
});

describe('checkAuth', () => {
  test('returns 405 for GET request', async () => {});
  test('returns 400 for missing fields', async () => {});
  test('returns 400 for invalid sessionCode format', async () => {});
  test('returns 429 when rate limit exceeded', async () => {});
  test('returns 403 for invalid poll token', async () => {});
  test('returns pending when receipt is missing', async () => {});
  test('returns 403 for invalid challenge token', async () => {});
  test('returns mismatch when sender != userPhone', async () => {});
  test('returns expired when verification request is stale', async () => {});
  test('returns verified true on success and deletes entry', async () => {});
  test('atomic delete prevents replay attack', async () => {});
});

describe('registerAuthenticator', () => {
  test('returns 403 without valid Authorization', async () => {});
  test('returns Firebase custom token for valid authenticator enrollment secret', async () => {});
});

describe('health', () => {
  test('returns 403 without valid Authorization', async () => {});
  test('returns healthy with active device', async () => {});
  test('returns degraded when no recent pings', async () => {});
  test('includes battery level in device list', async () => {});
  test('calculates queue depth correctly', async () => {});
});

describe('cleanupOldRequests', () => {
  test('deletes entries older than 24 hours', async () => {});
  test('preserves entries newer than 24 hours', async () => {});
  test('handles empty database gracefully', async () => {});
});
```

---

## Integration Testing

### End-to-End Verification Flow
```kotlin
@Test
fun `fullVerificationFlow succeeds with serverIssuedChallenge`() {
  // 1. Client calls startVerification
  // 2. SMS sent with returned smsBody (mocked SMS provider)
  // 3. Authenticator receives SMS, writes receipt to RTDB
  // 4. Client polls checkAuth with pollToken
  // 5. Verify response is verified: true
  // 6. Verify entry deleted from RTDB
}

@Test
fun `verificationFails when SMS sender mismatch`() {
  // SMS sent from +1111111111
  // Client claims +2222222222
  // Verify response is mismatch
}

@Test
fun `verificationExpires after timeout`() {
  // SMS not received within 30s
  // Verify polling returns timeout
}
```

### SMS failure retry flow
```kotlin
@Test
fun `smsFailureShowsRetryGuidance`() {
  // Simulate SecurityException on sendTextMessage
  // Verify retry guidance displayed
  // Verify the user can attempt resend
}
```

### Firebase Integration
```kotlin
@Test
fun `customAuth succeeds before RTDB write`() {
  // Verify registerAuthenticator returns Firebase custom token
  // Verify RTDB write succeeds after custom auth sign-in
}

@Test
fun `RTDB rules reject unauthorized write`() {
  // Attempt write without auth
  // Verify permission denied
}

@Test
fun `RTDB rules reject write missing required fields`() {
  // Attempt receipt write without receivedAt, sender, or challengeToken
  // Verify validation fails
}
```

---

## Security Testing

### Replay Attack Prevention
```kotlin
@Test
fun `same sessionCode cannot be verified twice`() {
  // Complete verification once
  // Attempt second verification with same sessionCode
  // Verify second attempt returns pending (entry deleted)
}
```

### Timing Attack Resistance
```kotlin
@Test
fun `tokenComparison takes constant time`() {
  // Measure comparison time for valid vs invalid poll/challenge token
  // Verify timing difference < 10ms (statistically insignificant)
}
```

### Brute Force Protection
```kotlin
@Test
fun `rateLimit blocks after 30 requests per minute`() {
  // Send 30 valid requests from same IP
  // Send 31st request
  // Verify 429 response
  // Wait 60s, verify request succeeds
}
```

### Clock Skew Handling
```kotlin
@Test
fun `clockSkew of 3 minutes causes rejection`() {
  // Set device clock 3 minutes ahead
  // Attempt verification
  // Verify expired_timestamp error
}
```

---

## Load Testing

### Capacity Planning (Free Tier)
| Metric | Target | Test Scenario |
|--------|--------|---------------|
| Daily verifications | 200 | Sustained load over 24h |
| Peak burst | 50/min | Spike test: 50 verifications in 1 minute |
| Concurrent requests | 30 | CF rate limit test |
| CF cold start | < 3s | Measure first request latency |

### Load Test Scenarios
```bash
# Sustained load test (24 hours)
artillery quick --count 200 --num 1 https://{CF_URL}/health

# Spike test (50 verifications in 1 minute)
artillery quick --count 50 --num 1 https://{CF_URL}/v4/startVerification

# Rate limit test (31 requests to trigger 429)
for i in {1..31}; do
  curl -X POST https://{CF_URL}/v4/checkAuth -d '{...}'
done
```

---

## Device Testing

### OEM Compatibility Matrix
| OEM | Android Version | Test Result | Notes |
|-----|----------------|-------------|-------|
| Samsung | 14 | ☐ | Baseline |
| Xiaomi | 13 | ☐ | Aggressive battery optimization |
| Oppo | 13 | ☐ | Auto-start required |
| Vivo | 12 | ☐ | Background restrictions |
| Huawei | 12 | ☐ | HMS instead of GMS (FCM issues?) |

### Service Persistence Tests
```kotlin
@Test
fun `serviceRestarts after device reboot`() {
  // Reboot device
  // Wait 5 minutes
  // Verify notification showing
  // Verify health ping received
}

@Test
fun `serviceSurvivesOemBatteryOptimization`() {
  // Enable aggressive battery optimization
  // Leave device idle for 1 hour
  // Send test SMS
  // Verify SMS received and processed
}

@Test
fun `serviceSurvivesAppSwipeAway`() {
  // Start service
  // Swipe app from recents
  // Send test SMS
  // Verify SMS received and processed
}
```

---

## Accessibility Testing

### Automated Checks (Android Accessibility Scanner / Accessibility Test Framework)
- [ ] All touch targets >= 48dp × 48dp (buttons, inputs)
- [ ] Color contrast ratio >= 4.5:1 for normal text, >= 3:1 for large text (WCAG 2.1 AA)
- [ ] `contentDescription` on all non-text interactive elements (icons, status indicator)
- [ ] Focus order is logical (phone input → verify button → status text)
- [ ] No content is conveyed by color alone (✅ and ❌ icons supplement green/red)
- [ ] Text is resizable up to 200% without clipping or overlap

### Manual Testing
| Scenario | Tool | Expected Behavior |
|----------|------|-------------------|
| Screen reader navigation | TalkBack (Android) | User can navigate to phone input, activate verify button, and hear status updates |
| High contrast mode | Android Settings → Accessibility → High contrast text | All text remains readable; status indicators visible |
| Large text (200%) | Android Settings → Display → Font size → Largest | Layout doesn't break; button text doesn't truncate; session code in fallback dialog remains fully visible |
| Switch access | Android Switch Access | All interactive elements are focusable and activatable |
| Voice control | Google Voice Access | User can say "tap verify" to activate the button |

### Authenticator App Accessibility
- The authenticator app is a single-screen utility running as a service. Minimal accessibility requirements:
  - [ ] Notification uses `IMPORTANCE_LOW` — does not interrupt user
  - [ ] Status text is readable by TalkBack ("Phone Authenticator, Running 24/7")
  - [ ] Auto-start button has content description
  - [ ] Battery optimization dialog is accessible (standard AlertDialog is accessible by default)

---

## Test Automation

### CI Pipeline Integration
```yaml
# .github/workflows/test.yml
name: Test Suite
on: [push, pull_request]
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Android Unit Tests
        run: ./gradlew test
      - name: Cloud Function Tests
        run: cd functions && npm test
      - name: Upload Coverage
        uses: codecov/codecov-action@v3
  
  integration-tests:
    runs-on: macos-latest
    steps:
      - name: Start Firebase Emulator
        run: firebase emulators:start --only functions,database
      - name: Run Integration Tests
        run: ./gradlew connectedAndroidTest
  
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Dependency Vulnerability Scan
        run: npm audit --audit-level=moderate
      - name: Static Analysis
        run: detekt && eslint
```

## Test execution order

Tests must run in this order to avoid false positives/negatives:

```
1. Unit Tests (fast, no external dependencies)
  ├── AuthCrypto tests (constant-time comparison, session code generation)
   ├── SmsReceiver tests (parsing, validation, prefix filtering)
   ├── PhoneAuthHelper tests (request building, response parsing)
  └── Cloud Function tests (startVerification, checkAuth, registerAuthenticator)

2. Integration Tests (Firebase Emulator required)
   ├── RTDB security rules tests (write validation, auth enforcement)
   ├── CF endpoint tests (full request lifecycle with emulator DB)
  └── Firebase auth integration (custom-token sign-in, token refresh)

3. End-to-End Tests (Android emulator + Firebase Emulator)
   ├── Full verification flow (SMS → RTDB → CF → verified)
   ├── SMS failure flow (retry guidance)
   └── Error scenarios (wrong phone, expired, rate limited)

4. Security Tests (run against staging environment)
   ├── Replay attack prevention
   ├── Timing attack resistance
   ├── Brute force rate limiting
   └── Secret exposure scan

5. Device Tests (physical devices only)
   ├── OEM battery optimization survival
   ├── Boot recovery
   └── App swipe survival

6. Load Tests (run against staging environment)
   ├── Sustained load (200 verifications/day simulation)
   └── Spike test (50 verifications/minute)
```

**CI runs:** Steps 1-2 on every PR. Steps 3-4 nightly. Steps 5-6 before release.

---

## Test Data Management

### Mock Data Fixtures
```kotlin
// TestConstants.kt
object TestConstants {
  const val VALID_SESSION_CODE = "A1B2C3D4E5"
  const val VALID_TIMESTAMP = 1712345678901L
  const val VALID_CHALLENGE_TOKEN = "aBC123..." // Computed with test secret
  const val VALID_POLL_TOKEN = "pOLL123..." // Computed with test secret
  const val VALID_USER_PHONE = "+8801712345678"
  const val TEST_VERIFICATION_SIGNING_SECRET = "test-secret-do-not-use-in-production-32chars"
}
```

### Firebase Emulator Suite
```bash
# Start emulator for local testing
firebase emulators:start --only functions,database,auth

# Import test data
firebase emulators:start --import=./test-data

# Export test data after setup
firebase emulators:export ./test-data
```

---

## Test Reporting

### Coverage Reports
- Unit test coverage: `./gradlew jacocoTestReport`
- Function coverage: `cd functions && npm run coverage`
- Minimum thresholds enforced in CI

### Test Result Dashboard
| Suite | Status | Coverage | Last Run |
|-------|--------|----------|----------|
| Unit Tests | ☐ | 85% | 2026-04-21 |
| Integration Tests | ☐ | 75% | 2026-04-21 |
| Security Tests | ☐ | 90% | 2026-04-21 |
| Device Tests | ☐ | N/A | 2026-04-21 |

---

## Definition of Test Readiness

All items must pass before production release:

- [ ] Unit test coverage >= 80% (100% for crypto)
- [ ] All integration tests pass
- [ ] Security tests pass (replay, timing, brute force)
- [ ] Load test confirms 200 verifications/day capacity
- [ ] Device tests pass on target OEM devices
- [ ] Accessibility audit passed
- [ ] CI pipeline green (lint, test, coverage)
- [ ] Manual QA sign-off on critical paths
