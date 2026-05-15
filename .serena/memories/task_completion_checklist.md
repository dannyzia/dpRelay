# Authenticator — Task Completion Checklist

When completing any code change, verify all of the following before declaring done:

## Checklist Version
v1.2 — Multi-tenant App Registry added (2025-06). Phases 1–13.

## Mandatory Checks
1. `./gradlew ktlintCheck` — zero issues
2. `./gradlew lint` — zero warnings
3. `cd functions && npm run lint` — zero warnings
4. `./gradlew test` — all pass
5. `cd functions && npm test` — all pass
6. No `Log.d`/`Log.v` in Kotlin
7. No `console.log` in JS
8. No hardcoded secrets (use Firebase Secrets Manager / EncryptedSharedPreferences)
9. No `!!` force-unwrap in Kotlin without documented reason
10. No `var` in JS
11. No `.then()` chains in JS

## Security
- HMAC comparisons use `crypto.timingSafeEqual()` (JS) or constant-time Kotlin equivalent
- No secrets logged
- No SMS body stored in RTDB
- Authenticator RTDB writes require `role=authenticator`

## Blockers (must never be violated)
- TD-09: `AUTHENTICATOR_ENROLLMENT_SECRET` must NOT be in BuildConfig — runtime-only
- TD-10: `SmsReceiver` MUST normalize phone numbers via `normalizeToE164()`
- Failure conditions in `docs/Plan/14-DEV-CHECKLIST.md` must all be clear

## Documentation
- All public functions have KDoc/JSDoc
- Complex logic has inline "why" comments (not "what")
- Update README.md and `.env.example` if new env vars added

## Coverage
- General: >= 80%
- Crypto code: 100%
