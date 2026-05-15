<!--
AI: This defines the system structure. Follow it. Do not introduce new layers without creating an ADR in 04-ADR.md.
Read first: 03-TECH-STACK.md, 04-ADR.md, 05-DATA-MODEL.md
You must: Follow the component boundaries defined here. Reference this when creating new modules.
You must not: Add services, databases, or external dependencies not listed here without creating an ADR first.
Human reviews this: YES — agree on architecture before implementation begins.
-->

# Architecture: Authenticator

> **Phone Number Authentication System v4.0**

## System overview
A self-hosted phone verification system using one dedicated Android phone as an SMS-to-Firebase bridge. Public client apps do not hold a long-lived verification secret. Instead, a Cloud Function issues a short-lived challenge, the client sends that challenge by SMS to the dedicated phone, and the authenticator phone records the SMS receipt in Firebase RTDB using a Firebase custom-auth identity bound to `role=authenticator`. A Cloud Function verifies the server-issued challenge, matches the sender phone, and returns verification status via POST endpoint.

## Architecture diagram

```text
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│  Ecommerce App      │     │  Medical App        │     │  Authenticator Phone    │
│  (User's Phone)     │     │  (User's Phone)     │     │  (Dedicated, 24/7)      │
│                     │     │                     │     │                         │
│  • Start verify     │     │  • Start verify     │     │  • Receive SMS          │
│  • Send SMS         │     │  • Send SMS         │     │  • Validate format      │
│  • Poll checkAuth ──┼──┐  │  • Poll checkAuth ──┼──┐  │  • Write receipt        │
│                     │  │  │                     │  │  │  • Report health        │
│  • Poll every 2s    │  │  │  • Poll every 2s    │  │  │  • Triple keep-alive    │
└─────────────────────┘  │  └─────────────────────┘  │  └──────────┬──────────────┘
                         │                            │             │
                         │    ┌───────────────────────┘             │
                         │    │                                       │
                    ┌────▼────▼─────────────────────────────────────▼─────┐
                    │   Firebase Cloud Functions (Gen 2)                  │
                    │                                                     │
                    │   /v4/startVerification   — Mint challenge         │
                    │   /v4/checkAuth           — Verify phone (POST)    │
                    │   /v4/registerAuthenticator — Issue device token   │
                    │   /health                 — Device liveness (GET)  │
                    │   /cleanupOldRequests     — Daily purge            │
                    └──────────────────────┬──────────────────────────────┘
                                           │
                    ┌──────────────────────▼──────────────────────────────┐
                    │   Firebase Realtime Database                        │
                    │                                                     │
                    │   /verification_requests/{sessionCode}              │
                    │     ├── createdAt (ServerValue.TIMESTAMP)           │
                    │     ├── expiresAt (Unix ms)                         │
                    │     ├── userPhone (E.164)                           │
                    │     └── receipt/                                    │
                    │         ├── receivedAt (ServerValue.TIMESTAMP)      │
                    │         ├── sender (originating phone number)       │
                    │         ├── challengeToken                          │
                    │         └── device (Build.MODEL)                    │
                    │                                                     │
                    │   /health/{androidId}                                │
                    │     ├── lastPing (ServerValue.TIMESTAMP)            │
                    │     ├── battery (0-100)                             │
                    │     └── device (Build.MODEL)                        │
                    └─────────────────────────────────────────────────────┘
```

## Components
| Component | Responsibility | Technology | Communicates with |
|-----------|---------------|------------|-------------------|
| Authenticator App | Receive SMS, validate shape/expiry, write receipt to RTDB, report health | Kotlin, Android SDK 26+, Firebase RTDB/FCM | Firebase RTDB, FCM, Cloud Functions |
| Cloud Functions (startVerification) | Mint short-lived verification challenge and active number | Node.js 20, Firebase Functions v2 | Firebase RTDB, Firebase Secrets |
| Cloud Functions (checkAuth) | Validate poll token, verify server-issued challenge, rate limit, atomic delete | Node.js 20, Firebase Functions v2 | Firebase RTDB, Firebase Secrets |
| Cloud Functions (registerAuthenticator) | Exchange authenticator enrollment secret for Firebase custom token | Node.js 20, Firebase Functions v2 | Firebase Auth Admin, Firebase Secrets |
| Cloud Functions (health) | Report authenticator liveness and queue depth | Node.js 20, Firebase Functions v2 | Firebase RTDB |
| Cloud Functions (cleanupOldRequests) | Delete DB entries older than 24h | Node.js 20, Firebase Functions v2 (scheduled) | Firebase RTDB |
| Firebase RTDB | Store verification requests, authenticator receipts, and health pings | Firebase Realtime Database | All components; authenticator app enables RTDB disk persistence before any DB call so writes queue offline and sync on reconnect |
| Client App (Ecommerce / Medical) | Request challenge, send SMS, poll CF | Kotlin, Android SDK | SMS (to dedicated phone), Cloud Functions |

## Request lifecycle
1. User enters phone number in client app.
2. Client sends `POST /v4/startVerification` with `{ userPhone }`.
3. Cloud Function validates phone format, rate-limits the request, generates `sessionCode`, `expiresAt`, `challengeToken`, and `pollToken`, and stores `/verification_requests/{sessionCode}` with `{ createdAt, expiresAt, userPhone }`.
4. Cloud Function returns `{ sessionCode, smsBody, dedicatedNumber, pollToken, expiresAt }`.
5. Client sends SMS `AUTH:{sessionCode}:{expiresAt}:{challengeToken}` to the returned dedicated number.
6. Authenticator `SmsReceiver` matches `AUTH:` prefix, splits on `:`, extracts `sessionCode`, `expiresAt`, and `challengeToken`, and rejects obviously expired payloads.
7. Authenticator signs into Firebase with a custom token whose claim set includes `role=authenticator`.
8. Authenticator normalises `originatingAddress` to E.164 when possible (e.g. prefixes `+880` for BD numbers lacking a country code). If the address is not normalizable, the raw sender value is written to the receipt so the Cloud Function can return `mismatch` instead of leaving the session `pending`.
9. Authenticator writes `{ receivedAt, sender, challengeToken, device }` to `/verification_requests/{sessionCode}/receipt`.
9. Client polls `POST /v4/checkAuth` with `{ sessionCode, pollToken }`.
10. Cloud Function validates request format, rate-limit, and poll token using `crypto.timingSafeEqual()`.
11. Cloud Function reads `/verification_requests/{sessionCode}` (O(1) lookup); returns `pending` if the request exists but no authenticator receipt has arrived.
12. Cloud Function recomputes the expected challenge token from the stored `userPhone`, `sessionCode`, and `expiresAt` using the server-only verification signing secret.
13. Cloud Function checks `receipt.challengeToken == expectedChallengeToken`; returns 403 if invalid.
14. Cloud Function checks `receipt.sender == userPhone`; returns `mismatch` if different.
15. Cloud Function checks request expiry; returns `expired` if stale.
16. Cloud Function atomically deletes `/verification_requests/{sessionCode}` and returns `{ verified: true, sender, sessionCode, processedAt }`.
17. Client receives `verified: true` and proceeds; polls every 2 seconds up to 30 seconds total.

## Data ownership
| Component | Owns | Must not read/write |
|-----------|------|---------------------|
| Authenticator App | `/verification_requests/*/receipt`, `/health/{androidId}` | Cloud Function config, top-level verification request creation/deletion, client app state |
| Cloud Functions | Creates and deletes `/verification_requests/*`, reads `/health/*`, reads queue depth | Client app state, authenticator service state |
| Client Apps | No Firebase access | RTDB directly, authenticator service state |

## External integrations
| Service | Purpose | Auth method | On failure |
|---------|---------|-------------|------------|
| Firebase RTDB | Verification data store | Firebase custom auth with `role=authenticator` for device writes; Admin SDK for server writes | SDK queues offline writes; syncs on reconnect |
| Firebase FCM | Remote high-priority wake-up ping to authenticator | FCM token stored in app | Not critical — alarm + WorkManager handles it |
| Firebase Secrets Manager | Store `VERIFICATION_SIGNING_SECRET`, `AUTHENTICATOR_ENROLLMENT_SECRET`, `HEALTH_ADMIN_SECRET`, `ACTIVE_DEDICATED_NUMBER` | Firebase CLI / IAM | Cloud Function refuses to start |
| Android SMS | Send/receive verification SMS | `RECEIVE_SMS` + `READ_SMS` runtime permissions | Prompt retry guidance when SMS fails |

## Security boundaries
- Authentication enforced at: Firebase RTDB rules (`auth.token.role == 'authenticator'` for device writes), Cloud Functions (server-issued challenge + poll token + rate limit)
- Input validated at: Authenticator (prefix + shape + expiry), Cloud Function (regex + poll token + challenge token + sender match + clock skew)
- Secrets never leave server boundary for public clients: `VERIFICATION_SIGNING_SECRET` and `HEALTH_ADMIN_SECRET` remain server-only; the authenticator receives only an authenticator-only enrollment secret.
- The `AUTHENTICATOR_ENROLLMENT_SECRET` **must not** be compiled into the APK as a `BuildConfig` constant. It must be supplied via a secure bootstrap mechanism (prompted on first run, injected via ADB, or loaded from a file excluded from source control). See TD-13 in 18-KNOWN-ISSUES.md.
- HMAC comparison: `AuthCrypto.constantTimeEquals()` in Kotlin; `crypto.timingSafeEqual()` in Node.js — never `===`

## Known risks
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SMS interception (SS7/SIM swap) | Medium | Verification bypassed | Server-issued challenge is time-bound and session-specific — cannot replay |
| OEM kills authenticator service | High | Verifications fail silently | Triple keep-alive: exact alarm (5 min) + WorkManager (15 min) + FCM ping |
| Dedicated phone loses Wi-Fi | Medium | Firebase writes delayed | Firebase SDK queues offline writes, syncs on reconnect |
| Authenticator enrollment secret compromised | Low | Attacker can enroll a rogue device | Rotate authenticator enrollment secret; re-enroll the dedicated phone; audit log on `registerAuthenticator` alerts on unexpected registrations (see PRD should-have #2) |
| No automated primary/secondary failover | Medium | All verifications fail while primary phone is offline | `startVerification` can check `/health` staleness and promote a secondary phone's number — not implemented in MVP; see PRD should-have #4 |
| Clock skew between devices | Low | Valid signatures rejected | 5-minute tolerance; devices use NTP auto-time |
| In-memory rate limiter lost on CF cold start | Low | Brief rate-limit bypass | Acceptable on free tier (single instance); see TD-01 in 18-KNOWN-ISSUES.md |

## Server-issued challenge explained

The server-issued challenge is the critical v4 security mechanism. Here's how it works:

```text
Step 1: CLOUD FUNCTION mints challenge
  input:  "{sessionCode}:{userPhone}:{expiresAt}"
  key:    VERIFICATION_SIGNING_SECRET
  output: challenge_A = Base64(HMAC-SHA256(VERIFICATION_SIGNING_SECRET, "{sessionCode}:{userPhone}:{expiresAt}"))

Step 2: CLOUD FUNCTION mints poll token
  input:  "POLL:{sessionCode}:{userPhone}:{expiresAt}"
  key:    VERIFICATION_SIGNING_SECRET
  output: poll_B = Base64(HMAC-SHA256(VERIFICATION_SIGNING_SECRET, "POLL:{sessionCode}:{userPhone}:{expiresAt}"))

Step 3: CLIENT sends SMS → AUTHENTICATOR
  SMS body: "AUTH:{sessionCode}:{expiresAt}:{challenge_A}"

Step 4: AUTHENTICATOR records receipt
  identity: Firebase custom auth with role=authenticator
  writes to RTDB: { receivedAt, sender, challengeToken: challenge_A, device }

Step 5: CLIENT sends POST → CLOUD FUNCTION
  body: { sessionCode, pollToken: poll_B }

Step 6: CLOUD FUNCTION validates poll token
  recomputes: poll_B' = Base64(HMAC-SHA256(VERIFICATION_SIGNING_SECRET, "POLL:{sessionCode}:{userPhone}:{expiresAt}"))
  checks:     poll_B == poll_B' (timingSafeEqual)
  → This proves the request corresponds to a server-issued verification session

Step 7: CLOUD FUNCTION validates authenticator receipt
  recomputes: challenge_A' = Base64(HMAC-SHA256(VERIFICATION_SIGNING_SECRET, "{sessionCode}:{userPhone}:{expiresAt}"))
  checks:     DB.receipt.challengeToken == challenge_A'
  checks:     DB.receipt.sender == userPhone
  → This proves the receipt matches a server-issued challenge and was written by an authenticator-role identity
  → If mismatch → invalid_challenge or mismatch
```

**Why this matters:** Without the server-issued challenge, a public client that knows a shared secret can forge verification state. In v4, public clients never hold the verification signing secret, and Firebase rules only allow authenticator-role identities to write SMS receipts.

## Network topology

```text
Client Phone                    Authenticator Phone           Firebase
┌──────────┐                    ┌──────────────────┐         ┌──────────────────┐
│          │──── SMS ─────────>│ SmsReceiver       │         │                  │
│          │  (carrier network) │  ↓ validates shape│         │                  │
│          │                    │  ↓ writes receipt │── Wi-Fi │  RTDB            │
│          │──── HTTPS POST ─────────────────────────────────>│  /verification_  │
│          │ start/poll         │                    │         │  requests/       │
│          │  (mobile data)    │                    │         │  /health/        │
│          │                    │ AuthFcmService     │         │                  │
│          │                    │  ↓ health ping     │── Wi-Fi │  CF checkAuth    │
│          │                    │                    │         │  CF health       │
└──────────┘                    └──────────────────┘         └──────────────────┘

Carrier network: Used for SMS only (user pays standard SMS rate)
Wi-Fi:          Required on authenticator phone for Firebase connectivity
Mobile data:    Used by client phone for HTTPS POST to Cloud Function
```

**Connectivity requirements:**
- **Client phone:** Must have either mobile data or Wi-Fi for the HTTPS POST. SMS sending requires cellular service.
- **Authenticator phone:** Must have Wi-Fi for Firebase RTDB writes. If Wi-Fi drops, Firebase SDK queues writes offline and syncs on reconnect. SMS reception works over cellular only (no Wi-Fi needed).
- **Cloud Functions:** Public internet. No VPN or private network required.
