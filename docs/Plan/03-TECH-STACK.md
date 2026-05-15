<!--
AI: This is the canonical list of every tool used in this project. Do not introduce new dependencies not listed here.
Read first: 04-ADR.md (for decisions that explain why these tools were chosen)
You must: Use exactly these tools and versions. Install via the listed package manager only.
You must not: Add libraries, frameworks, or services not listed here without creating an ADR.
Human reviews this: YES — confirm before starting implementation.
-->
---
project_name: Authenticator
project_description: Phone Number Verification System (Dedicated Android Phone + Firebase)
primary_language: Kotlin (Android) / JavaScript (Cloud Functions)
framework: Android SDK 26+ / Firebase Cloud Functions v2
database: Firebase Realtime Database
package_manager: Gradle (Android) / npm (Cloud Functions)
test_framework: JUnit4 + Mockito (Android unit) / Android Instrumentation (Android integration) / Jest (Functions)
linting: Android Lint / ESLint
formatting: ktlint / Prettier
typing: Kotlin strict null safety / JSDoc (JS)
min_sdk: 26 (Android 8.0)
target_sdk: 34 (Android 14)
---

# Tech Stack: Authenticator

## Approved dependencies

### Authenticator App (Android)
| Package | Version | Purpose | Alternatives rejected |
|---------|---------|---------|----------------------|
| com.google.firebase:firebase-database-ktx | 21.0.0 | RTDB read/write | Firestore (more complex, overkill for key-based schema) |
| com.google.firebase:firebase-auth-ktx | 23.0.0 | Firebase custom-token sign-in for authenticator-role RTDB access | Generic authenticated writer model without device role separation (insufficient trust boundary for verification writes) |
| com.google.firebase:firebase-messaging-ktx | 24.0.0 | FCM high-priority remote wake-up ping | None (no alternative for cloud-initiated wake) |
| androidx.work:work-runtime-ktx | 2.9.0 | WorkManager keep-alive (15 min) | JobScheduler (deprecated API, OEM-unreliable) |
| androidx.core:core-ktx | 1.13.0 | `ServiceCompat.startForeground()`, `ContextCompat` | N/A |
| androidx.appcompat:appcompat | 1.7.0 | `AppCompatActivity` | N/A |

> **Note:** Firebase Crashlytics (`com.google.firebase:firebase-crashlytics-ktx`) is required before production. The authenticator phone is headless, so crash reporting is mandatory for production readiness. See 01-PRD.md requirement 20 and 18-KNOWN-ISSUES.md TD-04.

### Cloud Functions (Node.js 20)
| Package | Version | Purpose | Alternatives rejected |
|---------|---------|---------|----------------------|
| firebase-admin | ^12.0.0 | Admin SDK for RTDB admin access | @firebase/database (client SDK, lacks admin privileges) |
| firebase-functions | ^6.0.0 | Cloud Functions v2 SDK | v1 (missing `defineSecret()`, updated scheduler) |

> No other npm packages. Node.js built-in `crypto` module handles HMAC — no external crypto lib needed.

## Runtime targets
| Target | Version | Notes |
|--------|---------|-------|
| Android minSdk | 26 (Android 8.0) | `SmsManager.createForSubscriptionId()` available from API 22; `FOREGROUND_SERVICE_REMOTE_MESSAGING` from API 29 — handle with `if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)` |
| Android targetSdk | 34 (Android 14) | Required for `USE_EXACT_ALARM` |
| Node.js | 20.x | Firebase Functions v2 requirement |
| Firebase Functions | v2 | Required for `defineSecret()` and updated scheduler |

## Global coding rules
- Language: Kotlin (Android) / JavaScript (Node.js — no TypeScript)
- Formatter: ktlint (Android) / Prettier (JS) — run before every commit
- Linter: Android Lint / ESLint — zero warnings allowed in committed code
- Null safety: Kotlin strict null safety — no `!!` force-unwrap except where absolutely required (document why)
- Tests required: all challenge-token logic, all input validation, all API error paths must have unit tests

## Environment targets
| Environment | Purpose | Branch | Firebase project | Notes |
|-------------|---------|--------|-----------------|-------|
| local | Development | any | — | Android emulator + Firebase Emulator Suite (`firebase emulators:start`) |
| staging | Pre-release | develop | `PhoneAuthService-dev` | Auto-deploys on merge to `develop` |
| production | Live users | main | `PhoneAuthService` | Manual deploy only; team lead authorization required |

## What is off-limits
- No raw SQL (Firebase RTDB only)
- No `console.log` in committed JS (use `logger.info` / `logger.warn` / `logger.error` from `firebase-functions/logger`)
- No `Log.d` / `Log.v` in committed Kotlin (use `Log.i` / `Log.w` / `Log.e` with tag constants)
- No secrets in source control — use Firebase Secrets Manager (`defineSecret`) or `BuildConfig` fields injected at build time
- No anonymous RTDB write path for verification data — device writes must use Firebase custom auth with `role=authenticator`
- No third-party SMS libraries — use `android.telephony.SmsManager` directly
- No Firestore — RTDB only
- No `any` type in Kotlin — use proper types or generics
- No `var` in JS — use `const` exclusively
- No `.then()` chains in JS — use `async/await` throughout
