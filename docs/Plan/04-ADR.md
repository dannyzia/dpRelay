<!--
AI: Create one ADR entry per significant architectural decision. This file lists all decisions.
Read first: 03-TECH-STACK.md (to check if a tool is already approved)
You must: Document every non-trivial technical decision here before implementing it.
You must not: Introduce a new dependency, pattern, or service without an ADR.
Human reviews this: YES — ADRs are decision records, not implementation logs.
-->

# Architecture Decision Records

Superseded ADRs remain in this file as historical context. Current implementation guidance for the active v4 design comes from the latest non-superseded ADRs, especially ADR-012 through ADR-014.

---

## ADR-001: HMAC-SHA256 for SMS authentication

| Field | Value |
|-------|-------|
| Date | 2026-04-01 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | ADR-012 |

### Context
Plaintext shared secrets in SMS bodies are vulnerable to SS7 interception, SIM swapping, and carrier breaches. NIST downgraded SMS OTP in 2016.

### Decision drivers
| Driver | Weight |
|--------|--------|
| Security | high |
| Cost (no third-party service) | high |
| Implementation simplicity | medium |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| Plaintext secret in SMS | Simplest | Interceptable, replayable, appears in logs | no |
| HMAC-SHA256 signature | Time-bound, non-replayable, no secret in SMS | Slightly more complex | yes |
| TOTP (RFC 6238) | Standardized | Requires tight clock sync, more complex client logic | no |

### Decision
Use HMAC-SHA256 with timestamp binding. SMS format: `AUTH:{sessionCode}:{timestamp}:{hmacSignature}` where `hmacSignature = Base64(HMAC-SHA256(SHARED_SECRET, "{timestamp}:{sessionCode}"))`.

### Consequences
- **Easier:** Time-bound signatures prevent replay; no raw secret in transit
- **Harder:** Clock skew between devices must be handled (5-minute tolerance)
- **Follow-up:** `AuthCrypto.kt` must be byte-identical in both authenticator and client apps; Cloud Function must use the same algorithm

---

## ADR-002: Firebase RTDB with session code as key

| Field | Value |
|-------|-------|
| Date | 2026-04-01 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | ADR-013 |

### Context
Need O(1) lookup for verification. Earlier versions used `push()` with `orderByChild` scan — O(n) as entries accumulate.

### Decision
Use session code as the Firebase RTDB key: `/sms_received/{sessionCode}`. Lookup is a direct `.ref.once("value")` — no index scan.

### Consequences
- **Easier:** O(1) lookup, no scan needed for primary read
- **Harder:** Each session code can only have one entry — acceptable since codes are single-use
- **Follow-up:** Add `.indexOn: ["timestamp"]` for the cleanup function's `orderByChild("timestamp").endAt(cutoff)` query

---

## ADR-003: Triple keep-alive for authenticator service

| Field | Value |
|-------|-------|
| Date | 2026-04-01 |
| Status | Accepted |
| Implementation Status | Partially Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
OEMs (Xiaomi, Oppo, Vivo, Huawei) aggressively kill foreground services. A single keep-alive mechanism is insufficient on these devices.

### Decision
Three-layer keep-alive:
1. `AlarmManager` exact alarm via `AlarmKeepAlive.kt` — fires every 5 minutes
2. `WorkManager` periodic task via `ServiceKeepAliveWorker.kt` — fires every 15 minutes
3. FCM high-priority message via `AuthFcmService.kt` — cloud-initiated wake-up

### Consequences
- **Easier:** Service survives most OEM power management; FCM provides remote wake-up
- **Harder:** Requires `SCHEDULE_EXACT_ALARM` (Android 12+) and `USE_EXACT_ALARM` (Android 13+) permissions; FCM requires `google-services.json` and valid FCM token
- **Follow-up:** Test on target OEM devices; show battery optimization and auto-start dialogs in `MainActivity`

---

## ADR-004: POST-only Cloud Function with Firebase Secrets Manager

| Field | Value |
|-------|-------|
| Date | 2026-04-01 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
Earlier versions used GET with secrets in URL query parameters. Query params appear in proxy logs, server access logs, and browser history — a significant security regression.

### Decision
`checkAuth` accepts POST only (return 405 on GET). All fields sent in JSON body. `AUTH_SHARED_SECRET` stored in Firebase Secrets Manager and accessed via `defineSecret("AUTH_SHARED_SECRET")`.

### Consequences
- **Easier:** No secrets in logs; centralized secret rotation
- **Harder:** Client must construct JSON body; requires Firebase Blaze plan for Secrets Manager access
- **Follow-up:** Rate-limit `checkAuth` by source IP; add CORS restriction to allow only app domains

---

## ADR-005: Firebase Anonymous Authentication for RTDB writes

| Field | Value |
|-------|-------|
| Date | 2026-04-01 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
Firebase RTDB security rules require `auth != null` for all reads and writes. The authenticator app is not a user-facing app and has no user identity. Options are: anonymous auth, custom token, or open rules.

### Decision
Use Firebase Anonymous Authentication (`FirebaseAuth.getInstance().signInAnonymously()`). The RTDB rules check `auth != null` — anonymous auth satisfies this without exposing admin credentials to the device.

### Consequences
- **Easier:** Simple one-time sign-in at service start; token auto-refreshes; no hardcoded credentials on device
- **Harder:** Anonymous auth must succeed before any RTDB write is possible; implement retry with exponential backoff on failure
- **Follow-up:** Cloud Functions use the Admin SDK which bypasses RTDB rules entirely — no auth needed there

---

## ADR-006: `Build.SERIAL` as health record key

| Field | Value |
|-------|-------|
| Date | 2026-04-01 |
| Status | Accepted |
| Implementation Status | Implemented (Changed to ANDROID_ID) |
| Supersedes | — |
| Superseded by | — |

### Context
The health endpoint needs a stable per-device key for `/health/{key}`. Options: `Build.SERIAL`, `Settings.Secure.ANDROID_ID`, or a generated UUID stored in SharedPreferences.

### Decision
Use `Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)`. `Build.SERIAL` returns `"unknown"` on Android 10+ without `READ_PHONE_STATE` permission (see TD-08). `ANDROID_ID` is stable per app install and requires no extra permission.

### Consequences
- **Easier:** No extra permission; stable across reboots; unique per device + app
- **Harder:** Resets on factory reset or app reinstall — acceptable since health data is ephemeral
- **Follow-up:** Update `AuthFcmService.kt` and `05-DATA-MODEL.md` to use `ANDROID_ID` as the health key; remove `Build.SERIAL` references

---

## ADR-007: `getBatteryLevel()` must be implemented before MVP

| Field | Value |
|-------|-------|
| Date | 2026-04-21 |
| Status | Accepted |
| Implementation Status | Not Implemented (MVP Blocker) |
| Supersedes | — |
| Superseded by | — |

### Context
TD-03 in `18-KNOWN-ISSUES.md` tracked `getBatteryLevel()` returning -1 as a low-severity known issue. However, the health endpoint (`06-API.md`) always includes `battery` in its response, and the health monitoring spec (`17-MONITORING.md`) relies on battery data for device health assessment. Returning -1 silently is misleading.

### Decision
`getBatteryLevel()` in `AuthFcmService.kt` must be fully implemented using `BatteryManager` (API 21+) before MVP ships. If the battery level is unavailable, return `-1` and log a warning — do not silently swallow it.

### Implementation
```kotlin
fun getBatteryLevel(context: Context): Int {
    val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) // returns -1 if unknown
}
```

### Consequences
- **Easier:** Health endpoint returns accurate battery data; operators can detect a dying phone
- **Harder:** None — `BatteryManager` is available from API 21, no extra permission needed
- **Follow-up:** Remove TD-03 from active issues in `18-KNOWN-ISSUES.md` once implemented

---

## ADR-008: JavaScript over TypeScript for Cloud Functions

| Field | Value |
|-------|-------|
| Date | 2026-04-21 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
Cloud Functions can be written in JavaScript or TypeScript. TypeScript provides type safety but adds build complexity.

### Decision drivers
| Driver | Weight |
|--------|--------|
| Simplicity (fewer build steps) | high |
| Developer familiarity | medium |
| Type safety | medium |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| JavaScript (Node.js 20) | No build step; simpler deployment; fewer dependencies | No static type checking | yes |
| TypeScript | Static types; better IDE support; catches bugs at compile time | Requires tsc compilation step; tsconfig management; longer CI builds | no |

### Decision
Use plain JavaScript with JSDoc type annotations for Cloud Functions. The codebase is small (3 functions, ~200 lines) — the overhead of TypeScript is not justified. JSDoc provides adequate documentation without build complexity.

### Consequences
- **Easier:** Faster CI; simpler deployment; no tsconfig maintenance
- **Harder:** No compile-time type checking; must rely on JSDoc and ESLint for type errors
- **Follow-up:** If the function codebase grows beyond 500 lines, reconsider TypeScript migration

---

## ADR-009: Single dedicated phone for MVP

| Field | Value |
|-------|-------|
| Date | 2026-04-21 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
The system could support multiple authenticator phones from day one, or start with a single phone and add multi-device support later.

### Decision drivers
| Driver | Weight |
|--------|--------|
| Implementation speed | high |
| Sufficient for initial volume | high |
| Operational simplicity | high |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| Single phone (MVP) | Simplest; no device coordination; one health endpoint to monitor | Single point of failure; limited capacity | yes |
| Multi-device from start | Redundancy; higher capacity | Requires device coordination, health aggregation, conflict resolution | no |

### Decision
Start with one dedicated phone. The health endpoint and data model (`/health/{androidId}`) already support multi-device — the architecture doesn't need to change to add more phones later. The operational burden of managing multiple phones doesn't justify the redundancy at ≤200 verifications/day.

### Consequences
- **Easier:** One phone to monitor, charge, and maintain; no device coordination logic
- **Harder:** Single point of failure — if the phone dies, all verifications fail until it's restarted
- **Follow-up:** If uptime requirements increase, add a second phone. The `/health` endpoint already reports per-device status; the `healthy` check just needs to accept `activeDevices >= 1` (already does)

---

## ADR-010: In-memory rate limiting with accepted cold-start tradeoff

| Field | Value |
|-------|-------|
| Date | 2026-04-21 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
Rate limiting state must persist across requests. Options: in-memory (Map), Firestore document, Redis, or external rate limiting service.

### Decision drivers
| Driver | Weight |
|--------|--------|
| Zero cost | high |
| Simplicity | high |
| Accuracy at scale | low |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| In-memory Map | Zero cost; simple; fast | Resets on cold start; not shared across instances | yes |
| Firestore document | Persists across cold starts; shared across instances | Firestore read/write costs; adds latency; overkill for simple counter | no |
| Redis (Upstash) | Fast; shared; persists | External service; cost; additional dependency | no |

### Decision
Use in-memory `Map<IP, timestamp[]>` for rate limiting. At ≤200 verifications/day on a single CF instance, the cold-start tradeoff is acceptable. On cold start, the rate limiter resets — an attacker gets a brief 30-request window. This is acceptable because:
1. Each request still requires valid HMAC — brute-forcing is impractical
2. Cold starts are infrequent (Firebase keeps instances warm for ~10 minutes)
3. Firebase free tier limits total invocations (2M/month) — natural upper bound

### Consequences
- **Easier:** Zero cost; no external dependencies; simple implementation
- **Harder:** Cold start resets limit; not shared across multiple CF instances
- **Production follow-up:** For higher availability or multi-instance deployment, migrate rate limiting to a distributed RTDB/Firestore counter document or transaction-based TTL entries. See TD-01 in 18-KNOWN-ISSUES.md

---

## ADR-011: Android SmsManager over SMS gateway API

| Field | Value |
|-------|-------|
| Date | 2026-04-21 |
| Status | Accepted |
| Implementation Status | Implemented |
| Supersedes | — |
| Superseded by | — |

### Context
The client app needs to send SMS to the dedicated phone. Options: Android's built-in SmsManager, or an HTTP-based SMS gateway API (Twilio, Vonage, MSG91).

### Decision drivers
| Driver | Weight |
|--------|--------|
| Zero cost per verification | high |
| Works offline | high |
| User experience | medium |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| SmsManager.sendTextMessage() | Free; works without internet; standard Android API | User pays standard SMS rate; requires SIM; requires SMS permissions | yes |
| SMS gateway API (Twilio/Vonage) | Reliable delivery; delivery receipts; no user SMS cost | $0.01-0.05 per SMS; requires internet; adds vendor dependency; API key management | no |
| Firebase Cloud Messaging | Free; instant; no SMS needed | Requires FCM integration on authenticator phone; doesn't verify phone number ownership (can send from any device) | no |

### Decision
Use `SmsManager.sendTextMessage()` directly. The user pays their standard SMS rate (typically ~0.50 BDT in Bangladesh). This is acceptable because:
1. SMS cost is minimal in Bangladesh
2. No vendor dependency or API key management
3. Works even without internet (SMS is cellular-only)
4. SMS failure retry guidance is available if SMS fails

The system shows retry guidance when SMS sending fails, prompting the user to fix permissions, SIM, or network issues and attempt resend.

### Consequences
- **Easier:** No vendor dependency; no API costs; works offline
- **Harder:** User pays SMS cost; no delivery receipt; SMS delivery not guaranteed
- **Follow-up:** If SMS delivery reliability becomes an issue, consider adding an SMS gateway as a secondary send channel (not replacing SmsManager)

---

## ADR-012: Server-issued verification challenge replaces client-held shared secret

| Field | Value |
|-------|-------|
| Date | 2026-04-30 |
| Status | Accepted |
| Implementation Status | Planned |
| Supersedes | ADR-001 |
| Superseded by | — |

### Context
In v3, public client apps held the same long-lived verification secret used by the authenticator and Cloud Function. A reverse-engineered client could therefore mint valid signatures and, combined with broad RTDB write access, forge verification state without a real SMS receipt.

### Decision
Move challenge minting to Cloud Functions. The client now starts verification with `POST /v4/startVerification`, receives `{ sessionCode, smsBody, dedicatedNumber, pollToken, expiresAt }`, sends the returned `smsBody` by SMS, and later polls `POST /v4/checkAuth` with `{ sessionCode, pollToken }`.

### Consequences
- **Easier:** Public clients no longer hold a long-lived verification secret; dedicated number can be changed server-side.
- **Harder:** Requires one extra network round trip before sending SMS.
- **Follow-up:** Server-side secrets must support overlap during rotation if challenge validity windows cross a deploy boundary.

---

## ADR-013: Firebase custom auth with `role=authenticator` for device writes

| Field | Value |
|-------|-------|
| Date | 2026-04-30 |
| Status | Accepted |
| Implementation Status | Planned |
| Supersedes | ADR-005 |
| Superseded by | — |

### Context
Anonymous auth on RTDB does not distinguish the dedicated authenticator device from a forged client or a generic script. Verification receipts need a narrower writer identity.

### Decision
Use a Firebase custom token issued by `POST /v4/registerAuthenticator` and embed the custom claim `role=authenticator`. RTDB rules allow only identities with `auth.token.role == 'authenticator'` to write `/verification_requests/{sessionCode}/receipt` and `/health/{androidId}`.

### Consequences
- **Easier:** Restores a meaningful trust boundary around verification receipts while preserving RTDB offline queueing.
- **Harder:** Requires authenticator enrollment and token refresh handling on the dedicated phone.
- **Follow-up:** Replace static enrollment secrets with one-time enrollment or secure bootstrap when the operational tooling exists.

---

## ADR-014: Split secrets by responsibility

| Field | Value |
|-------|-------|
| Date | 2026-04-30 |
| Status | Accepted |
| Implementation Status | Planned |
| Supersedes | — |
| Superseded by | — |

### Context
Using one secret for client signing, authenticator behavior, and admin health checks creates wide blast radius and expensive incident response.

### Decision
Split secrets into:
1. `VERIFICATION_SIGNING_SECRET` — server-only, used to mint and verify challenge and poll tokens
2. `AUTHENTICATOR_ENROLLMENT_SECRET` — authenticator-only bootstrap secret used for device registration
3. `HEALTH_ADMIN_SECRET` — admin-only secret protecting `/health`
4. `ACTIVE_DEDICATED_NUMBER` — server-managed current SMS target number

### Consequences
- **Easier:** Rotating verification logic no longer requires client app updates; health access can be restricted separately.
- **Harder:** More secrets to manage in Firebase Secrets Manager.
- **Follow-up:** Document rotation and emergency handling per secret in `11-ENV-VARS.md` and `15-RUNBOOK-DEPLOY.md`.

---

## ADR-015: E.164 normalisation of SMS originating address in SmsReceiver

| Field | Value |
|-------|-------|
| Date | 2026-05-01 |
| Status | Accepted |
| Implementation Status | Not Implemented (MVP Blocker) |
| Supersedes | — |
| Superseded by | — |

### Context
Android's `SmsMessage.getOriginatingAddress()` returns the raw value provided by the carrier. In Bangladesh, carriers frequently omit the country code prefix, delivering `01712345678` instead of `+8801712345678`. If `SmsReceiver` writes the raw value to RTDB as `sender`, the Cloud Function's `receipt.sender == userPhone` equality check will always fail because `userPhone` is stored in E.164 format (`+8801712345678`). The result is a silent `mismatch` on every legitimate verification — the system appears broken with no actionable error message.

### Decision drivers
| Driver | Weight |
|--------|--------|
| Correctness (no silent mismatch) | high |
| Security (sender must still be verified) | high |
| Simplicity | medium |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| Normalise in `SmsReceiver` before RTDB write | Fix at source; single place to test and audit | Must handle multiple carrier formats | yes |
| Normalise in Cloud Function `checkAuth` | Centralised | Server does not know which country's carrier sent the SMS | no |
| Store raw value; compare loosely in CF | Avoids normalisation code | Loose comparison is a security regression; harder to audit | no |

### Decision
Normalise `originatingAddress` to E.164 in `SmsReceiver.normalizeToE164()` before any RTDB write or comparison. The normalisation rules for Bangladesh are:

| Raw format | Normalised to |
|-----------|--------------|
| `+8801XXXXXXXXX` | unchanged |
| `8801XXXXXXXXX` | `+8801XXXXXXXXX` |
| `01XXXXXXXXX` | `+8801XXXXXXXXX` |
| anything else | write as-is (produces `mismatch`, not silent `pending`) |

Non-normalisable addresses must still be written to RTDB so that `checkAuth` returns `mismatch` immediately rather than hanging as `pending` until the 5-minute expiry.

### Implementation
```kotlin
/**
 * Normalises a raw SMS originating address to E.164 for Bangladesh numbers.
 * Non-normalisable addresses are returned unchanged so that checkAuth returns
 * `mismatch` rather than `pending` indefinitely.
 */
fun normalizeToE164(raw: String, defaultCountryCode: String = "+880"): String {
    if (raw.startsWith("+")) return raw
    if (raw.startsWith("880")) return "+$raw"
    if (raw.startsWith("0")) return "$defaultCountryCode${raw.substring(1)}"
    return raw
}
```

### Consequences
- **Easier:** Eliminates silent `mismatch` failures caused by carrier formatting differences; single function, easy to unit test
- **Harder:** The `defaultCountryCode` is hardcoded to Bangladesh (`+880`). Multi-country deployments would need to resolve the country code from the SIM or from a user-provided hint.
- **Follow-up:** Unit test with at least four formats. If the system is ever deployed outside Bangladesh, refactor `normalizeToE164` to accept the SIM's country ISO code.

---

## ADR-016: Runtime supply of AUTHENTICATOR_ENROLLMENT_SECRET (no BuildConfig)

| Field | Value |
|-------|-------|
| Date | 2026-05-01 |
| Status | Accepted |
| Implementation Status | Not Implemented (MVP Blocker) |
| Supersedes | — |
| Superseded by | — |

### Context
The initial design compiled `AUTHENTICATOR_ENROLLMENT_SECRET` into the APK as a `BuildConfig` constant. This is a critical security gap: any APK distributed beyond the immediate development team can be trivially decompiled with `jadx` or `apktool`, exposing the secret in plaintext. The enrollment secret grants `role=authenticator` write access to Firebase RTDB. An attacker with this secret can enroll a rogue device, write forged verification receipts, and bypass phone verification entirely.

This system has no app store distribution — the APK is sideloaded onto a single dedicated phone and never published. Even so, compiling a secret into a build artifact violates the system's own security model and sets a dangerous precedent.

### Decision drivers
| Driver | Weight |
|--------|--------|
| Secret not extractable from APK | high |
| No additional infrastructure (no internet, no server roundtrip for secret fetch) | high |
| Operational simplicity for single-device setup | medium |

### Options considered
| Option | Pros | Cons | Fits drivers? |
|--------|------|------|---------------|
| `BuildConfig` constant (current) | Easy build process | Secret extractable from APK; prohibited | no |
| First-run prompt → `EncryptedSharedPreferences` | No APK change needed after enrollment; uses Android Keystore | Requires physical access to enter secret on first launch | yes |
| ADB environment variable at launch | No user interaction; easily scripted | Requires ADB access on first start; not persistent across reboots without extra setup | yes |
| External secrets file excluded from `.gitignore` | Simple; no user interaction | File must be on device; excluded from source control | yes |
| Remote bootstrap API (fetch secret from server on first run) | Fully automated | Adds infrastructure; chicken-and-egg: needs a separate auth mechanism | no |

### Decision
Use first-run prompt stored in `EncryptedSharedPreferences` as the default mechanism. The authenticator `MainActivity` checks on start whether the enrollment secret is already stored; if not, it presents a secure text input dialog. The entered value is stored with `EncryptedSharedPreferences` (backed by Android Keystore). Subsequent starts read from storage directly.

`BuildConfig` must not contain `AUTHENTICATOR_ENROLLMENT_SECRET`. The `build.gradle` file must contain only `CF_URL` as a `BuildConfig` field.

### Implementation notes
```kotlin
// Read at service start — never from BuildConfig
val enrollmentSecret: String = EncryptedPrefsHelper.getOrPrompt(context, "enrollment_secret")
    ?: throw IllegalStateException("Enrollment secret not configured")

// Store after first-run prompt:
EncryptedPrefsHelper.store(context, "enrollment_secret", enteredValue)
```

Use `androidx.security:security-crypto` (`EncryptedSharedPreferences` + `MasterKey`).

### Consequences
- **Easier:** APK decompilation reveals no secrets; enrollment secret is stored in hardware-backed keystore on supported devices
- **Harder:** First run requires manual entry; if the app is uninstalled and reinstalled the enrollment secret must be re-entered (acceptable for a single dedicated phone)
- **Security note:** If the device is physically compromised, the Keystore-backed secret may still be extractable on rooted or unlocked-bootloader devices. This risk is accepted: a compromised dedicated phone is already covered by Scenario 2 in the threat model.

---

## ADR-017: Receipt delivery via RTDB only; FCM Data Message fallback deferred

**Status:** Decided — 2026-05-01
**Deciders:** Project team

### Context
The authenticator phone writes its SMS receipt to Firebase RTDB. If RTDB is unreachable (network interruption), the Firebase SDK queues the write offline and syncs when connectivity is restored. An alternative design was considered: the authenticator pushes the receipt directly to a Cloud Function via an FCM Data Message, bypassing RTDB entirely for the write path.

### Options considered
| Option | Pros | Cons | Chosen? |
|--------|------|------|---------|
| RTDB write only (current) | Simple; offline queue is built into Firebase SDK; no extra code | Delivery delayed until Wi-Fi reconnects | yes |
| FCM Data Message fallback | Receipt arrives even without Wi-Fi if mobile data is available; lower latency on patchy networks | Significant added complexity: new CF endpoint, FCM auth, receipt deduplication across two paths, test surface doubles | no |
| SMS-to-CF report | Zero Wi-Fi dependency | Costs SMS money; slower than Wi-Fi; defeats purpose of the system | no |

### Decision
Use RTDB write only. The dedicated authenticator phone runs on a stable Wi-Fi connection. Firebase SDK offline persistence (`FirebaseDatabase.getInstance().setPersistenceEnabled(true)`) handles brief disconnections transparently. The FCM Data Message fallback is documented as TD-15 in 18-KNOWN-ISSUES.md and can be revisited if Wi-Fi reliability becomes a production problem.

### Consequences
- **Easier:** Single write path; no deduplication logic; straightforward test surface
- **Harder:** Verifications are delayed (not failed) during Wi-Fi outages; no mobile-data fallback in MVP
- **Trigger for revisit:** Wi-Fi failure rate on the dedicated phone increases, or TD-15 is promoted to a production incident
