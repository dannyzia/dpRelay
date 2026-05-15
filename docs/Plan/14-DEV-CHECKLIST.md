<!--
AI: This markdown file is the human-readable companion to 14-DEV-CHECKLIST.yaml.
Read first: 14-DEV-CHECKLIST.yaml (authoritative AI checklist), 01-PRD.md (requirements), 20-TEST-PLAN.md (testing requirements), 22-THREAT-MODEL.md (security requirements)
You must: Use 14-DEV-CHECKLIST.yaml as the machine-readable source of truth for AI execution and checklist tracking. Use this file for human review and discussion.
You must not: Treat this markdown file as the authoritative AI checklist when it differs from the YAML file.
Human reviews this: YES — checklist must be approved during code review.
-->

> **Note:** `14-DEV-CHECKLIST.yaml` is the canonical checklist for AI agents and machine-readable workflow automation.
> This markdown file is the human-readable companion for review, walkthroughs, and code review.
> If there's any discrepancy between the two, the YAML file takes precedence for AI execution and checklist tracking.

# Development Checklist
**Project:** Authenticator

## How to Use This Checklist
- Check off items as they are completed
- All items in a section must be complete before moving to next phase
- Security checks are non-negotiable
- Reference related documents for implementation details

---

## Phase 1: Cryptography & Security

### Challenge Token Implementation
- [ ] Cloud Function mints a server-issued challenge token in `startVerification`
- [ ] Cloud Function mints a server-issued poll token in `startVerification`
- [ ] `AuthCrypto.kt` has constant-time comparison (no `===` for secrets)
- [ ] Cloud Function uses constant-time comparison for token comparison (custom implementation)
- [ ] `SecureRandom` used for session code generation (not UUID)
- [ ] Clock skew tolerance is 300 seconds (5 minutes) in all three apps
- [ ] Session code format validated: `/^[A-Z0-9]{8,16}$/`

### Key Management
- [ ] `VERIFICATION_SIGNING_SECRET` stored only in Firebase Secrets Manager
- [ ] Public client app contains no long-lived verification signing secret
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` is authenticator-only
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` is **not** compiled into the APK as a `BuildConfig` constant (see ADR-016)
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` is supplied at runtime via first-run prompt and stored in `EncryptedSharedPreferences`
- [ ] `HEALTH_ADMIN_SECRET` is separate from verification secrets
- [ ] All secrets are 32+ characters, cryptographically random
- [ ] No secrets are logged anywhere (no `console.log`, no `Log.d`)
- [ ] `build.gradle` `buildConfigField` entries contain only `CF_URL` (no enrollment or signing secrets)

### Threat Mitigations (see 22-THREAT-MODEL.md)
- [ ] Replay attack prevented (atomic delete on verification success)
- [ ] Brute force prevented (30 requests/minute rate limiting)
- [ ] Timing attacks prevented (constant-time comparison)
- [ ] Clock skew attacks prevented (plus-minus 5 minute tolerance)
- [ ] Database tampering prevented (server-issued challenge + authenticator-only RTDB role)

---

## Phase 2: Android Service Implementation

### Foreground Service
- [ ] Foreground service with `remoteMessaging` type implemented
- [ ] `FOREGROUND_SERVICE_REMOTE_MESSAGING` permission in manifest
- [ ] `SCHEDULE_EXACT_ALARM` and `USE_EXACT_ALARM` permissions in manifest
- [ ] `WAKE_LOCK` permission in manifest
- [ ] `RECEIVE_SMS` and `READ_SMS` permissions in manifest
- [ ] `POST_NOTIFICATIONS` permission in manifest (Android 13+)

### Keep-Alive Mechanisms
- [ ] Exact alarm keep-alive (5 min) implemented in `AlarmKeepAlive.kt`
- [ ] `AlarmKeepAlive.kt` uses `AlarmManager.setExactAndAllowWhileIdle()`
- [ ] WorkManager keep-alive (15 min) implemented in `ServiceKeepAliveWorker.kt`
- [ ] `ServiceKeepAliveWorker.kt` uses `ExistingPeriodicWorkPolicy.KEEP`
- [ ] FCM service (`AuthFcmService.kt`) reports health to RTDB
- [ ] `AuthFcmService.kt` handles high-priority messages correctly
- [ ] Boot receiver restarts service on `BOOT_COMPLETED`
- [ ] `BootReceiver.kt` handles `MY_PACKAGE_REPLACED` for app updates

### Firebase Integration
- [ ] Authenticator registers with `registerAuthenticator`
- [ ] Firebase custom auth succeeds before any RTDB write
- [ ] Exponential backoff on auth failure (1s, 2s, 4s, 8s, max 16s)
- [ ] FCM token retrieved and valid
- [ ] Firebase Crashlytics integrated and reporting to the Firebase console
- [ ] Crashlytics non-fatal report on normalisation failure (unrecognised address format)

### SMS Handling
- [ ] SMS receiver filters by `AUTH:` prefix
- [ ] Non-`AUTH:` SMS are silently discarded (no logging of body)
- [ ] SMS body is never stored in database (only `receivedAt`, `sender`, `challengeToken`, `device`)
- [ ] SMS parsing handles malformed messages gracefully
- [ ] `SmsReceiver.normalizeToE164()` implemented (see ADR-015)
- [ ] Normalisation handles `+8801XXXXXXXXX`, `8801XXXXXXXXX`, and `01XXXXXXXXX` formats
- [ ] Non-normalisable address is written to RTDB as-is (so `checkAuth` returns `mismatch`, not `pending`)
- [ ] `normalizeToE164` has 100% unit test coverage across all four input formats

### User Experience
- [ ] Battery optimization dialog with explanation shown on first launch
- [ ] Auto-start button for Chinese ROMs (Xiaomi, Oppo, Vivo)
- [ ] Exact alarm permission request on Android 12+
- [ ] Notification channel created (`IMPORTANCE_LOW`)
- [ ] Notification shows "Running 24/7 - Listening for SMS"

---

## Phase 3: Cloud Functions Implementation

### Verification Functions
- [ ] `startVerification` accepts POST only
- [ ] `startVerification` validates `userPhone` format: `/^\+[0-9]{7,15}$/`
- [ ] `startVerification` returns `sessionCode`, `smsBody`, `dedicatedNumber`, `pollToken`, and `expiresAt`
- [ ] Accepts POST only (returns 405 on GET)
- [ ] Validates request format (regex, field presence)
- [ ] Validates `sessionCode` format: `/^[A-Z0-9]{8,16}$/`
- [ ] Rate-limits by IP (30 req/min)
- [ ] Validates poll token with `crypto.timingSafeEqual()` (returns 403 if invalid)
- [ ] Performs O(1) lookup by sessionCode key (not scan)
- [ ] Verifies receipt challenge token against the server-issued challenge
- [ ] Checks `receipt.sender == userPhone` (returns `mismatch` if different)
- [ ] Checks verification request expiry (returns `expired` if stale)
- [ ] Atomically deletes entry on success (prevents replay)
- [ ] Returns proper error codes in all failure cases
- [ ] `registerAuthenticator` exchanges the authenticator enrollment secret for a Firebase custom token

### health Function
- [ ] Requires `Authorization: Bearer {HEALTH_ADMIN_SECRET}` header
- [ ] Validates secret with constant-time comparison
- [ ] Returns 403 for missing/invalid authorization
- [ ] Reads all `/health` entries
- [ ] Calculates `activeDevices` (last ping within 10 minutes)
- [ ] Reads `/verification_requests` count for `queueDepth`
- [ ] Returns `status: "healthy"` if `activeDevices >= 1` AND `queueDepth <= 100`
- [ ] Returns device list with battery levels

### cleanupOldRequests Function
- [ ] Scheduled to run every 24 hours
- [ ] Queries `/verification_requests` with `orderByChild('createdAt').endAt(cutoff)`
- [ ] Deletes all entries older than 24 hours
- [ ] Logs count of deleted entries
- [ ] Handles empty result gracefully
- [ ] Requires `.indexOn: ["createdAt"]` in RTDB rules

### Configuration & Security
- [ ] `VERIFICATION_SIGNING_SECRET`, `AUTHENTICATOR_ENROLLMENT_SECRET`, and `HEALTH_ADMIN_SECRET` loaded from Firebase Secrets Manager via `defineSecret()`
- [ ] `config.js` centralizes all constants
- [ ] No `console.log` in production code (use `logger.info/warn/error`)
- [ ] No secrets in error messages or logs
- [ ] CORS configured appropriately (allow only app domains)

---

## Phase 4: Client Integration

### PhoneAuthHelper.kt
- [ ] Uses POST with JSON body (not GET with query params)
- [ ] Uses `HttpsURLConnection` (not `HttpURLConnection`)
- [ ] Handles `SecurityException` on SMS send with retry guidance
- [ ] Handles `NullPointerException` on SMS send with retry guidance
- [ ] Handles no SIM scenario with retry guidance
- [ ] Polling interval is 2 seconds
- [ ] Polling timeout is 30 seconds
- [ ] Stops polling on `verified: true`, `mismatch`, 403, or 429
- [ ] Specific error handling for 429 (rate limited)
- [ ] Specific error handling for 403 (invalid signature)
- [ ] Specific error handling for 400 (bad request/expired)

### SMS send failure handling
- [ ] Dialog shows retry guidance when SMS fails
- [ ] "Retry SMS" button available
- [ ] No raw session code exposed to end users
- [ ] Does not block user from continuing

---

## Phase 5: Firebase Configuration

### Realtime Database Rules
- [ ] Rules deny client reads of `/verification_requests`
- [ ] Rules allow `/verification_requests/{sessionCode}/receipt` writes only for `auth.token.role == 'authenticator'`
- [ ] Rules validate `hasChildren(['receivedAt', 'sender', 'challengeToken'])`
- [ ] Rules have `.indexOn: ["createdAt"]` for cleanup function
- [ ] Rules have `.indexOn: ["lastPing"]` for health queries
- [ ] Rules have `$other: { ".validate": false }` (no extra fields)
- [ ] Rules validate field types (number for timestamp, string for sender)
- [ ] Firebase custom auth flow tested for authenticator-role writes
- [ ] `/registered_apps` — admin SDK write only; authenticator role read only (for smsTemplate lookup)
- [ ] `/pending_sms` — admin SDK write; authenticator role read + delete only; no public access
- [ ] `/otp_requests` — admin SDK only (zero client or authenticator access)

### Security Rules Validation
- [ ] Unit tests pass against Firebase Emulator
- [ ] Unauthorized write rejected (no auth)
- [ ] Write missing required fields rejected
- [ ] Write with extra fields rejected
- [ ] Read without auth rejected

---

## Phase 6: Testing

### Unit Tests
- [ ] AuthCrypto: 100% coverage
- [ ] HMAC generation tests pass
- [ ] Constant-time comparison tests pass
- [ ] Clock skew validation tests pass
- [ ] Session code generation tests pass

### Integration Tests
- [ ] End-to-end verification flow passes
- [ ] Invalid poll token rejection test passes
- [ ] Rate limiting test passes (31st request returns 429)
- [ ] Clock skew > 5 min rejection test passes
- [ ] Invalid challenge token returns 403
- [ ] SMS failure retry guidance works

### Security Tests
- [ ] Replay attack prevented (entry deleted after use)
- [ ] Brute force attack blocked (rate limit works)
- [ ] Timing attack resistance verified
- [ ] Secret not in source control (git scan passes)

### Device Tests
- [ ] Tested on Samsung device (Android 14)
- [ ] Tested on Xiaomi device (aggressive battery optimization)
- [ ] Service survives device reboot
- [ ] Service survives app swipe from recents

---

## Phase 7: Code Quality

### Linting & Formatting
- [ ] Android Lint passes with zero warnings
- [ ] ktlint passes with zero issues
- [ ] ESLint passes with zero warnings
- [ ] No `Log.d` / `Log.v` in committed Kotlin code
- [ ] No `console.log` in committed JavaScript code
- [ ] All imports sorted per project conventions

### Documentation
- [ ] All public functions have docblocks
- [ ] Complex logic has explanatory comments (why, not what)
- [ ] No TODO/FIXME comments in production code
- [ ] README.md updated if new environment variables added
- [ ] `.env.example` updated if new variables added

### Git Hygiene
- [ ] Commit messages follow Conventional Commits format
- [ ] Branch naming follows convention (`feature/`, `bugfix/`, `hotfix/`)
- [ ] No secrets in git history (verified with scan)
- [ ] Rebase/squash done for clean history before merge

---

## Phase 8: Pre-Deployment Verification

### Environment Setup
- [ ] `VERIFICATION_SIGNING_SECRET` configured in Firebase Secrets Manager
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` configured in Firebase Secrets Manager and authenticator build
- [ ] `ACTIVE_DEDICATED_NUMBER` matches authenticator phone SIM
- [ ] `CF_URL` points to correct environment (staging/prod)
- [ ] Firebase Blaze plan enabled (required for Functions v2)
- [ ] Cloud Functions region closest to users

### Staging Verification
- [ ] Health endpoint returns `healthy` on staging
- [ ] End-to-end verification works on staging
- [ ] Rate limiting tested on staging
- [ ] Invalid poll token returns 403 on staging
- [ ] Staging stable for minimum 24 hours

### Production Readiness
- [ ] Team lead approval obtained
- [ ] Security review completed (if crypto/auth code changed)
- [ ] Rollback plan documented and tested
- [ ] Monitoring and alerts configured
- [ ] On-call rotation established

---

## Definition of Done

A feature is **complete** when:

1. **All Phase 1-13 checkboxes are checked**
2. **Linter passes with zero warnings**
3. **Kotlin compiler passes with zero errors**
4. **All tests pass** (unit, integration, security)
5. **Test coverage >= 80%** (100% for crypto code)
6. **Public clients contain no long-lived verification signing secret**
7. **Authenticator RTDB writes require `role=authenticator`**
8. **Health endpoint returns healthy** after deployment
9. **Code review approved** by at least one team member
10. **Documentation updated** (README, .env.example if needed)

---

## Phase 9: App Registry — Multi-Tenant Foundation

> Every client app is a first-class entity in RTDB. No app name, template, or rate limit is hardcoded in any Cloud Function. Adding a new app requires only a POST to `registerApp` — zero code changes.

### Cloud Functions
- [ ] `registerApp` (POST) implemented, gated by `APP_MASTER_SECRET`
- [ ] `registerApp` validates `masterSecret` with `timingSafeEqual` (constant-time)
- [ ] `registerApp` stores `apiKeyHash = HMAC(APP_MASTER_SECRET, appId+appSecret)` — **never** the raw `appSecret`
- [ ] `smsTemplate` defaults to `"Your {appName} code: {otp}. Valid {ttl} minutes. Do not share."` if not provided
- [ ] `rateLimit` defaults to `{ maxPerPhone: 3, windowMs: 600000 }` if not provided
- [ ] `registerApp` returns `{ appId, appSecret }` — `appSecret` shown once, caller must save immediately
- [ ] `revokeApp` (POST) implemented, gated by `APP_MASTER_SECRET`
- [ ] `revokeApp` sets `active = false` (soft delete — preserves audit trail)
- [ ] All `sendOtp` calls for a revoked `appId` return 403 `app_revoked`

### Secrets
- [ ] `APP_MASTER_SECRET` added to Firebase Secrets Manager
- [ ] `APP_MASTER_SECRET` added to `.env.example` (empty value, with `openssl rand -base64 48` instructions)
- [ ] `APP_MASTER_SECRET` added to `docs/Plan/11-ENV-VARS.md`

### RTDB Rules
- [ ] `/registered_apps` rules: admin-write, authenticator-read, no public access
- [ ] Required fields validated: `name`, `apiKeyHash`, `active`, `createdAt`

### Tests
- [ ] `registerApp returns appId and appSecret for valid masterSecret`
- [ ] `registerApp rejects invalid masterSecret with 403`
- [ ] `registerApp stores HMAC hash not raw appSecret in RTDB`
- [ ] `revokeApp sets active=false for valid appId`
- [ ] `sendOtp rejects app with active=false`

---

## Phase 10: Outbound OTP — Cloud Functions

> All OTP functions are multi-tenant. Every call must identify itself with `appId` + `appSecret`. Rate limits, TTLs, and SMS templates are read from `/registered_apps/{appId}` at runtime — none are hardcoded.

### sendOtp
- [ ] Accepts `{ appId, appSecret, phoneNumber }` in POST body
- [ ] Reads `/registered_apps/{appId}` — returns 403 if missing or `active=false`
- [ ] Validates `appSecret` using `timingSafeEqual(HMAC(APP_MASTER_SECRET, appId+appSecret), stored apiKeyHash)`
- [ ] Reads `rateLimit` from `/registered_apps/{appId}/rateLimit` (falls back to `{ maxPerPhone:3, windowMs:600000 }`)
- [ ] Rate limit key is `appId+phoneNumber` (app-scoped, not global)
- [ ] Generates 6-digit OTP with `crypto.randomInt(100000, 999999)`
- [ ] Stores `hashedOtp = HMAC(VERIFICATION_SIGNING_SECRET, sessionId+otp)` — never plaintext OTP
- [ ] Reads `smsTemplate` from `/registered_apps/{appId}/smsTemplate`, renders `{otp}` and `{ttl}` placeholders
- [ ] Writes `/pending_sms/{sessionId}` with rendered `message`, `to`, `appId`, `status: 'pending'`, `createdAt`
- [ ] Writes `/otp_requests/{sessionId}` with `appId`, `phoneNumber`, `hashedOtp`, `expiresAt`, `attempts: 0`, `locked: false`
- [ ] Returns `{ sessionId, expiresAt }` — **never** returns the OTP or the SMS message text

### verifyOtp
- [ ] Accepts `{ appId, sessionId, otp }` in POST body
- [ ] Returns 404 `not_found` if session is missing
- [ ] Validates `session.appId === req.appId` — returns 403 `app_mismatch` on cross-app attempt
- [ ] Returns 423 `locked` if `locked=true`
- [ ] Returns 410 `expired` if past `expiresAt`
- [ ] Atomically increments `attempts`; sets `locked=true` after 3 failures
- [ ] Constant-time HMAC comparison for OTP validation
- [ ] On success: atomically deletes `/otp_requests/{sessionId}` and `/pending_sms/{sessionId}`
- [ ] Returns `{ verified: true, phoneNumber }` on success
- [ ] Returns `{ verified: false, reason: "mismatch|locked|expired|not_found|app_mismatch" }` on failure

### otpStatus
- [ ] `otpStatus` (GET) returns `{ status: 'pending'|'sent'|'failed'|'expired'|'not_found' }`
- [ ] `resend=true` re-generates and re-queues when `status=failed`
- [ ] `resend=true` returns 409 `already_sent` when status is `sent` or `pending`
- [ ] `resend=true` returns 410 when status is `expired` (caller must call `sendOtp` again)

### Cleanup
- [ ] `cleanupOldRequests` purges `/otp_requests` where `expiresAt < cutoff`
- [ ] `cleanupOldRequests` purges `/pending_sms` where `status=sent|failed` AND `createdAt < (now - 24h)`
- [ ] Active `pending` entries are NOT deleted by cleanup

---

## Phase 11: Outbound OTP — Authenticator App (SMS Sender)

### Permissions
- [ ] `SEND_SMS` permission added to `AndroidManifest.xml`
- [ ] `SEND_SMS` requested at runtime in `MainActivity.kt`

### PendingSmsListener
- [ ] `PendingSmsListener.kt` created
- [ ] Watches `/pending_sms` with `addChildEventListener`
- [ ] On new child: reads `{ to, message }`, sends via `SmsManager.sendTextMessage()`
- [ ] `SentIntent` is **never** null (delivery confirmation required)
- [ ] On `RESULT_OK` (sent): updates `/pending_sms/{sessionId}/status` to `sent`
- [ ] On `RESULT_ERROR_*` (failed): writes `status: 'failed'` and `errorMsg` to `/pending_sms/{sessionId}`
- [ ] 60-second client-side timeout fallback: writes `failed` if no `SentIntent` callback received

### Service Integration
- [ ] `PendingSmsListener` started inside `AuthenticatorService` after Firebase sign-in succeeds
- [ ] `PendingSmsListener` stopped in `stopService()`
- [ ] Listener only runs while Firebase auth is active

---

## Phase 12: HaatBazar Client SDK

> **This phase is tracked here for dependency ordering only.** The SDK code lives in the HaatBazar repository. `appSecret` must never appear in the mobile app — route all `sendOtp` calls through HaatBazar's own backend.

- [ ] `sendOtp(appId, appSecret, phoneNumber)` added to `PhoneAuthHelper.kt`
- [ ] `verifyOtp(appId, sessionId, otp)` added to `PhoneAuthHelper.kt`
- [ ] `CF_SEND_OTP_URL` and `CF_VERIFY_OTP_URL` added to `BuildConfig` / `.env`
- [ ] `appSecret` **not** present anywhere in the mobile app source
- [ ] Integration tests cover: valid flow, revoked app, invalid secret, expired OTP, locked, app_mismatch, rate limit

---

## Phase 13: UX Hardening — One-Time Permission Dialogs

- [ ] Skip SMS/notification permission dialog if already granted (`checkSelfPermission` before `requestPermissions`)
- [ ] Skip battery optimization dialog if device is already exempt (`isIgnoringBatteryOptimizations`)
- [ ] Auto-start dialog shown only once per install (flag `autostart_prompted` in `SharedPreferences`)

---

## Failure Conditions

If any of these are found, the feature is **not production-ready**:

- [ ] **Public client app contains server-only verification secret**
- [ ] **HMAC comparison uses `===`** instead of constant-time
- [ ] **Cloud Function accepts GET requests** (must be POST only)
- [ ] **SMS body stored in database** (only `receivedAt`, `sender`, `challengeToken`, `device` allowed)
- [ ] **Authenticator logs personal (non-AUTH) SMS**
- [ ] **Rate limiting not implemented**
- [ ] **Atomic delete not implemented** (replay possible)
- [ ] **Secrets found in source control**
- [ ] **No unit tests for HMAC/crypto logic**
- [ ] **`AUTHENTICATOR_ENROLLMENT_SECRET` present in APK as a `BuildConfig` constant** (T-09 — pre-production blocker)
- [ ] **`SmsReceiver` writes raw `originatingAddress` without E.164 normalisation** (T-10 — pre-production blocker)
- [ ] **Rogue device enrolled** — more than one `androidId` appears in `/health` without deliberate addition of a second phone (T-11)
- [ ] **Panic button procedure untested** — Firebase Auth UID revocation for a compromised device has never been exercised on staging (T-11)
- [ ] **`sendOtp` does not validate `appId`+`appSecret` against `/registered_apps`** — unauthenticated OTP sending possible
- [ ] **`appSecret` stored in plaintext in `/registered_apps`** — must store HMAC hash only
- [ ] **`sendOtp` uses a hardcoded rate-limit constant** instead of reading from `/registered_apps/{appId}/rateLimit`
- [ ] **`verifyOtp` does not validate `appId` against session's `appId`** — cross-app OTP replay possible
- [ ] **`APP_MASTER_SECRET` absent from Firebase Secrets Manager or `.env.example`**
- [ ] **`appSecret` embedded in mobile app source** — must be server-side (HaatBazar backend) only

---

## Validation Commands

Run these before declaring complete:

```bash
# Linting
./gradlew lint           # Android Lint
./gradlew ktlintCheck    # ktlint
cd functions && npm run lint  # ESLint

# Testing
./gradlew test         # Unit tests
./gradlew jacocoTestReport  # Coverage report
cd functions && npm test    # Function tests

# Security scan
git log --all --full-history -- '*.kt' '*.js' | grep -i "secret\|password"

# Health check
curl -H "Authorization: Bearer $SECRET" $CF_URL/health
```

---

## Checklist Metadata

| Field | Value |
|-------|-------|
| Version | 1.2 |
| Last Updated | 2025-06 (multi-tenant v1.2) |
| Related Documents | 01-PRD.md, 20-TEST-PLAN.md, 22-THREAT-MODEL.md |
| Owner | Development Team |
| Approver | Tech Lead |
