# Authenticator — Tech Stack

## Languages
- Kotlin (Android app, minSdk 26 / targetSdk 34)
- JavaScript / Node.js 20 (Cloud Functions — no TypeScript)

## Android Dependencies
- firebase-database-ktx:21.0.0
- firebase-auth-ktx:23.0.0
- firebase-messaging-ktx:24.0.0
- androidx.work:work-runtime-ktx:2.9.0
- androidx.core:core-ktx:1.13.0
- androidx.appcompat:appcompat:1.7.0
- Firebase Crashlytics (required before production — TD-04)

## Cloud Functions Dependencies
- firebase-admin:^12.0.0
- firebase-functions:^6.0.0
- Node.js built-in `crypto` for HMAC (no external crypto libs)

## Tooling
- Build: Gradle (Android), npm (CF)
- Test: JUnit4 + Mockito (Android) / Jest (CF)
- Lint: Android Lint + ESLint (zero warnings policy)
- Format: ktlint (Android) / Prettier (JS)
- Coverage: Jacoco (Android, 80% threshold, 100% for crypto)

## Database
Firebase Realtime Database (RTDB only — no Firestore, no SQL)

## Secrets Management
Firebase Secrets Manager (`defineSecret()`) — never hardcoded, never in BuildConfig.
`AUTHENTICATOR_ENROLLMENT_SECRET` is runtime-only via EncryptedSharedPreferences (ADR-016, TD-09 resolved).

## Off-limits
- No `console.log` in JS production code — use `logger.info/warn/error`
- No `Log.d`/`Log.v` in Kotlin — use `Log.i/w/e` only
- No `var` in JS — `const` only
- No `.then()` chains in JS — async/await only
- No `any` type in Kotlin
- No `!!` force-unwrap in Kotlin (except documented)
- No third-party SMS libs — use android.telephony.SmsManager
