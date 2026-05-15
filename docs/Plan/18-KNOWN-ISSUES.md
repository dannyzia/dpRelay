<!--
AI: Track all known bugs and tech debt here. Check this before fixing bugs or taking on new work.
Read first: 01-PRD.md (to check if a known issue affects MVP scope)
You must: Add an entry here when you introduce tech debt. Check this list before starting work on a bug.
You must not: Apply a workaround for an issue listed here without updating its entry. Close an issue without moving it to Resolved.
Human reviews this: NO — AI maintains this. Human reviews during sprint planning.
-->

# Known Issues & Tech Debt
**Project:** Authenticator

## How to use this document
- **Before fixing a bug:** Check if it is already listed here. Reference the entry in your PR.
- **Before adding a workaround:** Add the underlying issue to this list first.
- **Trigger for re-evaluation:** The condition under which this issue should be prioritized or re-examined.

## Active issues
| ID | Description | Severity | Workaround | Trigger for re-evaluation | Linked issue |
|----|-------------|----------|------------|---------------------------|-------------|
| TD-01 | In-memory rate limiter resets on CF cold start; not shared across instances | low | Acceptable for single-instance free tier deployment | Upgrade to distributed RTDB/Firestore rate limiting when scaling beyond 1 CF instance |
| TD-02 | `KeepAliveReceiver.isServiceRunning()` uses SharedPreferences timestamp — not 100% reliable | low | Dual keep-alive (alarm + WorkManager) provides redundancy | Service dying despite both mechanisms |
| TD-03 | ~~`AuthFcmService.getBatteryLevel()` returns -1~~ — Resolved per ADR-007, now uses `BatteryManager.BATTERY_PROPERTY_CAPACITY` | ~~high~~ → resolved | — | — |
| TD-04 | No Firebase Crashlytics integration yet | **high** | Using Log.d/Log.e for debugging | The device is headless; silent crashes cannot be reported by a user. Must be integrated before production. |
| TD-05 | CORS should be restricted to known app origins | low | Current implementation restricts to configured domains; `authenticator` and `yourapp` patterns in index.js | If third-party web clients need access |
| TD-06 | SMS costs user money (standard SMS rate) | low | Retry guidance available when SMS fails | Volume exceeds free-tier tolerance |
| TD-07 | OEM exact alarm permission may be revoked silently on some devices | medium | WorkManager (15 min) acts as fallback | Users report service dying on specific OEMs |
| TD-08 | No automated APK build and distribution pipeline | medium | Manual APK build and sideload | Frequency of authenticator app updates increases |
| TD-09 | Missing automated integration tests for Cloud Functions; `computeChallenge` / `computePollToken` crypto paths have no unit test coverage | **high** | Manual testing before release | Any CF deploy touching crypto logic is unguarded; production incidents |
| TD-10 | No automated authenticator re-enrollment procedure after `AUTHENTICATOR_ENROLLMENT_SECRET` rotation | medium | Manual APK rebuild or manual re-enrollment on the dedicated phone | Compliance audit requirement |
| TD-11 | No formal load testing performed on free tier limits | low | Capacity planning based on estimates | Approaching 200 verifications/day |
| TD-12 | `SmsReceiver` writes raw `originatingAddress` to RTDB without E.164 normalisation. Carriers may omit country code (e.g. `01712345678` instead of `+8801712345678`), causing silent `mismatch` failures. | **high** | None — a non-matching sender causes `mismatch` with no user-visible explanation | Any `mismatch` report that cannot be reproduced with a clean send |
| TD-13 | `AUTHENTICATOR_ENROLLMENT_SECRET` is compiled into the APK as a `BuildConfig` constant. Anyone who decompiles the APK can obtain authenticator-role credentials. | **high** | Treat the enrollment secret as a short-lived credential; rotate if APK is distributed outside the team | Pre-production — must be resolved before the APK leaves the development environment |
| TD-14 | No alerting when the authenticator phone is powered off or has lost network connectivity but the process has not crashed. Crashlytics only fires on crashes — a phone sitting offline silently blocks all verifications with no operator notification. | **medium** | Health endpoint (`GET /health`) timestamp allows passive polling; no active push alert exists | If operator reports "verification not working" and Crashlytics shows no crash |
| TD-15 | No fallback receipt delivery if RTDB is unreachable. FCM Data Messages were considered as an alternative path (authenticator pushes receipt directly to a Cloud Function via FCM), but this adds significant complexity. Current mitigation — Firebase SDK offline queue + reconnect — is sufficient for Wi-Fi-connected dedicated phones. | low | Firebase SDK queues writes offline and syncs on reconnect | Wi-Fi failure rate increases on the dedicated phone's network |
| TD-16 | Client-side SMS send has no automatic retry. On `SmsManager.sendTextMessage()` failure the client currently surfaces static retry guidance. Should be upgraded to automatic retry with exponential backoff (1 s, 2 s, 4 s) using `PendingIntent` status callbacks before the 30-second polling window expires. | medium | Retry guidance is shown; user can re-trigger verification | User friction reports increase |

## Resolved
| ID | Description | Resolved in |
|----|-------------|-------------|
| TD-R01 | Plaintext shared secret in SMS (v1/v2) | v3.0 — HMAC-SHA256 signatures |
| TD-R02 | Secrets in URL query parameters (v1/v2) | v3.0 — POST body only |
| TD-R03 | UUID.randomUUID() predictable session codes (v1/v2) | v3.0 — SecureRandom |
| TD-R04 | Single keep-alive mechanism (v2) | v3.0 — Triple: exact alarm + WorkManager + FCM |
| TD-R05 | No rate limiting (v1/v2) | v3.0 — Per-IP 30/min |
| TD-R06 | No replay protection (v1/v2) | v3.0 — Atomic delete on verification |
| TD-R07 | `Build.SERIAL` returns "unknown" on Android 10+ | v3.0 — Using `Settings.Secure.ANDROID_ID` per ADR-006 |
