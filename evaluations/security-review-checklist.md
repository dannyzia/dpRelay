# Security Review Checklist

**Purpose:** Comprehensive security evaluation covering authentication, authorization, input validation, data exposure, crypto correctness, secrets management, and Firebase rules.

## Authentication
- [ ] Firebase custom auth tokens include `role` claim
- [ ] `auth.token.role == 'authenticator'` enforced on all write paths
- [ ] `registerAuthenticator` validates `AUTHENTICATOR_ENROLLMENT_SECRET`
- [ ] Challenge tokens signed with `VERIFICATION_SIGNING_SECRET`
- [ ] `pollToken` is not reusable (consumed on use)
- [ ] No fallback to anonymous Firebase auth for sensitive operations

## Authorization
- [ ] RTDB rules prevent one client from reading another's verification requests
- [ ] Web dashboard users cannot access admin routes without admin role
- [ ] Health endpoint protected by `HEALTH_ADMIN_SECRET`
- [ ] No privilege escalation paths (authenticator cannot become admin)

## Input Validation
- [ ] Phone numbers validated as E.164 format (`+880...`)
- [ ] Challenge tokens validated for correct length and character set
- [ ] Session codes validated (alphanumeric, length-bounded)
- [ ] SMS body parsed with strict format matching (not regex scanning)
- [ ] HTTP request body size limited
- [ ] All Firebase Function parameters type-checked

## Data Exposure
- [ ] No SMS body text stored in Firebase RTDB
- [ ] Only `receivedAt`, `sender`, `challengeToken`, `device` fields in receipt
- [ ] No PII exposed in error messages or logs
- [ ] Secrets length logged only, never value
- [ ] HTTP response bodies contain only necessary data

## Crypto Correctness
- [ ] HMAC comparison uses constant-time (`crypto.timingSafeEqual()` / `AuthCrypto.constantTimeEquals()`)
- [ ] NOT using `===` for token or HMAC comparison
- [ ] `crypto.randomBytes()` used for token generation (not `Math.random()`)
- [ ] Clock skew tolerance applied correctly (`CLOCK_SKEW_MS`)
- [ ] No weak hash algorithms used

## Secrets Management
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` in `EncryptedSharedPreferences`, not `BuildConfig`
- [ ] `VERIFICATION_SIGNING_SECRET` in Firebase Secrets Manager
- [ ] `HEALTH_ADMIN_SECRET` in Firebase Secrets Manager
- [ ] `ACTIVE_DEDICATED_NUMBER` in Firebase Secrets Manager
- [ ] No secrets in Git history

## Firebase Rules
- [ ] No public read/write on any path
- [ ] Authenticator paths scoped to role
- [ ] Verification request paths isolated per-session
- [ ] Rules tested against emulator before deploy
- [ ] Default deny at root level

## Sign-off
- [ ] All critical and high issues resolved
- [ ] Medium issues tracked with owners
- [ ] Security review documented
