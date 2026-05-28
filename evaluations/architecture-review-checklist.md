# Architecture Review Checklist

**Purpose:** Evaluate separation of concerns, data flow correctness, security boundaries, dependency analysis, and scalability.

## Separation of Concerns
- [ ] Authenticator app is a dedicated foreground service — no UI logic mixed in
- [ ] Cloud Functions handle only orchestration (mint tokens, verify receipts) — no direct device interaction
- [ ] Web dashboard is a separate consumer — no server-side logic in React
- [ ] Client library (`PhoneAuthHelper.kt`) is standalone — does not import authenticator app internals
- [ ] `AuthCrypto.kt` contains all crypto logic — not scattered across files

## Data Flow Correctness
- [ ] Request lifecycle: Client -> `startVerification` -> RTDB challenge -> SMS -> Authenticator -> receipt write -> `checkAuth` -> atomic delete
- [ ] No shortcut paths that bypass the server-issued challenge
- [ ] `pollToken` is single-use (deleted atomically with receipt check)
- [ ] Authenticator does not initiate verification — only responds to received SMS
- [ ] Health pings flow: Authenticator -> `/health` endpoint -> RTDB write

## Security Boundaries
- [ ] RTDB rules enforce role-based access (authenticator can write, clients can read their own)
- [ ] Challenge tokens are opaque to clients — only the server can verify them
- [ ] Secrets never leave their boundary (enrollment secret stays on device, signing secret stays on server)
- [ ] No direct database access from web dashboard (all through Cloud Functions)
- [ ] Dedicated number is the only trusted SMS source

## Dependency Analysis
- [ ] No circular dependencies between modules
- [ ] Firebase Admin SDK version pinned and compatible
- [ ] Android dependencies have no known security vulnerabilities
- [ ] Node.js dependencies audited (`npm audit` passes)
- [ ] Kotlin coroutines used correctly (no GlobalScope leaks)

## Scalability
- [ ] RTDB write patterns consider concurrent verification requests
- [ ] `cleanupOldRequests` paginates or batches deletes
- [ ] Rate limiting prevents SMS flood attacks
- [ ] Firebase Function cold start times acceptable for user-facing flow
- [ ] Health pings are lightweight (avoid overwhelming RTDB)
- [ ] No unbounded data growth (cleanup function runs on TTL)

## Observability
- [ ] Health monitoring provides early warning of authenticator failure
- [ ] Verification request completion rate is measurable
- [ ] Error types are distinguishable (network vs. auth vs. timeout)
- [ ] Firebase Crashlytics integrated (known issue TD-04)

## Approval
- [ ] Architect review completed
- [ ] Any violations documented as tech debt in known issues
- [ ] ADR updated for any architectural changes
