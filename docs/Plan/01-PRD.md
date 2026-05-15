<!--
AI: This is the source of truth for what to build. Read it before writing any code.
Read first: 03-TECH-STACK.md, 19-GLOSSARY.md
You must: Implement every functional requirement. Treat every acceptance criterion as a pass/fail test.
You must not: Build anything not listed here. Assume scope. Modify acceptance criteria without human approval.
Human reviews this: YES — do not begin implementation until a human has filled in this document.
-->

# Product Requirements: Authenticator

> **Phone Number Authentication System v4.0**

## Problem statement
Ecommerce and medical apps need to verify that users own the phone numbers they provide. Third-party SMS verification services cost money and require ongoing vendor management. A self-hosted solution using one dedicated Android phone with a SIM card can provide zero-cost verification using Firebase's free tier.

## Users
| User type | Description | Primary goal |
|-----------|-------------|-------------|
| End user | Customer using ecommerce/medical app | Verify their phone number during registration or checkout |
| Admin | Developer/operator managing the system | Monitor system health, rotate secrets, maintain dedicated phone |

## User personas

### End user (ecommerce customer)
- **Demographics:** Urban and rural Bangladesh, ages 18-55, variable technical literacy
- **Device:** Mid-range Android phone (Samsung, Xiaomi, Oppo, Vivo), Android 8-14
- **Connectivity:** Mobile data (3G/4G) primary; Wi-Fi secondary; intermittent coverage in rural areas
- **Behavior:** Expects instant verification; will abandon if process takes >30 seconds; distrusts complex flows
- **Pain points:** SMS costs money (standard rate); may have poor signal; may not understand "verification code" concept

### End user (medical patient)
- **Demographics:** All ages, often elderly or with low technical literacy; may be assisted by clinic staff
- **Device:** Any Android phone; may be older/lower-end
- **Connectivity:** Clinic Wi-Fi or mobile data; may be in areas with poor coverage
- **Behavior:** Follows guided instructions; may need help from clinic staff; less likely to troubleshoot errors
- **Pain points:** Confused by error messages; may not have SMS credit; may close app during verification

### Admin / Operator
- **Demographics:** Developer or technical operator maintaining the system
- **Device:** Laptop for monitoring; dedicated Android phone for authenticator
- **Technical level:** Familiar with Firebase Console, basic networking, Android sideloading
- **Responsibilities:** Monitor health endpoint, rotate secrets every 6 months, keep dedicated phone charged and online, deploy Cloud Function updates
- **Pain points:** OEM killing authenticator service; device needing physical access for troubleshooting

## Functional requirements

### Must-have (MVP)
1. Client app starts verification by calling `POST /v4/startVerification` with `userPhone` over HTTPS.
2. Cloud Function generates a cryptographically secure session code, a 5-minute expiry, a server-signed SMS challenge token, and a poll token.
3. Cloud Function returns `sessionCode`, `smsBody`, `dedicatedNumber`, `pollToken`, and `expiresAt` to the client app; the dedicated number is server-configured, not hardcoded in the client.
4. Client app sends the returned SMS body in format `AUTH:{sessionCode}:{expiresAt}:{challengeToken}` to the dedicated phone number.
5. Client app does not hold any long-lived verification signing secret.
6. Authenticator app receives SMS, validates prefix/shape/expiry, and writes the receipt to Firebase RTDB under `/verification_requests/{sessionCode}/receipt`.
7. Authenticator app authenticates to Firebase using a custom token with claim `role=authenticator`; anonymous RTDB writes are not allowed.
8. Client app polls `POST /v4/checkAuth` with `sessionCode` and `pollToken` every 2 seconds for up to 30 seconds; stops on `verified: true`, `mismatch`, 403, or 429.
9. Cloud Function validates the poll token with `crypto.timingSafeEqual()`, performs O(1) lookup by `sessionCode`, rate-limits by IP (30 req/min), and never trusts client-supplied sender data.
10. Cloud Function verifies that the authenticator receipt challenge matches the server-issued challenge, checks `sender == userPhone`, and atomically deletes the verification record on success.
11. SMS failure retry guidance is available when SMS sending fails (`SecurityException`, `NullPointerException`, no SIM).
12. Authenticator app runs as foreground service (`FOREGROUND_SERVICE_REMOTE_MESSAGING` type) with persistent notification, 24/7.
13. Authenticator app filters SMS by `AUTH:` prefix — non-matching SMS are silently discarded; SMS body is never logged.
14. Authenticator app uses triple keep-alive: exact alarm (5 min) + WorkManager (15 min) + FCM high-priority ping.
15. Scheduled Cloud Function deletes verification records older than 24 hours to prevent storage bloat.
16. Health monitoring endpoint reports authenticator device liveness (last ping within 10 min), battery level, and queue depth.
17. Authenticator app reports health by writing to `/health/{androidId}` with the same `role=authenticator` Firebase identity.
18. Authenticator app enrolls once with `POST /v4/registerAuthenticator` using an authenticator-only enrollment secret to obtain a Firebase custom token. The enrollment secret **must not** be compiled into the APK; it must be supplied via a secure bootstrap mechanism (e.g., stored on the device after first-run prompt, injected via ADB environment variable, or loaded from a secrets file excluded from the repository).
19. `SmsReceiver` normalises `originatingAddress` to E.164 format (`+880` prefix for BD numbers) before writing `sender` to RTDB whenever that conversion is possible. If the carrier-supplied address is not normalizable, the raw sender string is still written so `checkAuth` can return `mismatch` instead of leaving the session `pending` until expiry.
20. Firebase Crashlytics must be integrated in the authenticator app before it goes to production. The device is headless; silent crashes cannot be reported by a user.

### Should-have (post-MVP)
1. Firebase App Check integration for Cloud Functions
2. Structured audit log for every `POST /v4/registerAuthenticator` call — success or failure — recording timestamp, source IP, and device ID. Alert if more than one distinct device registers within a rolling 5-minute window (unless a second phone is being deliberately added). Stored in Firebase RTDB `/audit/registrations/{pushId}` and optionally streamed to BigQuery.
3. Terraform/Infra-as-Code for reproducible deployments
4. Automated primary/secondary failover across multiple authenticator phones: if the primary phone's `/health/{androidId}` `lastPing` is stale by >10 minutes, `startVerification` automatically promotes the secondary phone's number as `dedicatedNumber`. The active device selection logic lives entirely in Cloud Functions — no client change required. Each additional phone increases throughput linearly.
5. Client-side SMS auto-retry with exponential backoff using `SmsManager` status callbacks (`RESULT_ERROR_*`). On failure, retry up to 3 times with delays of 1 s, 2 s, and 4 s before surfacing a user-visible error.

### Explicitly out of scope
1. Two-factor authentication (2FA) — this system is for phone number verification only
2. User account management or user profiles
3. Third-party SMS gateway services (Twilio, Vonage, MSG91, etc.) — the purpose of this system is to eliminate these entirely. Falling back to a gateway is not a migration path.
4. iOS authenticator app
5. Web-based admin dashboard

## Competitive context
| Alternative | Cost | Why not chosen |
|------------|------|----------------|
| Firebase Phone Auth | Free tier, then $0.01/verification | Requires user to enter OTP manually; no control over SMS provider; costs scale with usage |
| Twilio Verify | $0.05/verification | Expensive at scale; adds vendor dependency; 200 verifications/day = $300/month |
| Vonage Number Verify | $0.03-0.05/verification | Similar cost concerns; less Firebase integration |
| Self-hosted SMS gateway (e.g., modem + SIM) | Hardware cost only | This project is essentially this approach, but using a dedicated Android phone instead of a modem — simpler setup, no drivers, Firebase SDK handles offline writes |
| **This system** | $0 (Firebase free tier) + one-time phone cost (~$50-80) | Zero per-verification cost; full control; but requires physical phone maintenance and has single-device limitation |

**Why this approach wins:** The Firebase free tier covers all infrastructure costs at ≤200 verifications/day. The only cost is the one-time phone purchase (~$50-80) and the user's standard SMS rate. No vendor lock-in, no per-verification fees, full control over the flow. **Scale is achieved by adding more dedicated phones** — each additional phone increases throughput linearly. Migrating to a third-party SMS gateway is not a scaling strategy; it defeats the purpose of this system.

## Non-functional requirements
| Category    | Requirement                                    | How to verify           |
|-------------|------------------------------------------------|-------------------------|
| Performance | Cloud Function P95 latency < 500ms             | Load test with 30 concurrent |
| Security    | Server-issued challenge tokens; public clients hold no long-lived verification secret; timing-safe comparison; no secrets in URL/logs | Security review |
| Reliability | 99% SMS-to-verification success within 30s when service is alive | End-to-end test |
| Scalability | Support 200 verifications/day on Firebase free tier | Capacity planning |

## Business KPIs
| KPI | Target | Measurement |
|-----|--------|-------------|
| Verification completion rate | > 95% | Successful verifications / verification attempts |
| Average verification time | < 15 seconds | Time from SMS send to `verified: true` |
| SMS retry usage | < 5% | Retry guidance activations after SMS send failure / total attempts |
| System uptime | > 99.5% | Minutes health endpoint reports "healthy" / total minutes |
| Cost per verification | $0.00 | Firebase free tier covers up to 200 verifications/day |
| User abandonment rate | < 10% | Verification attempts that don't complete within 30 seconds |

## Acceptance criteria
| ID   | Criterion                        | Verified by              |
|------|----------------------------------|--------------------------|
| AC-1 | `startVerification` returns `sessionCode`, `smsBody`, `dedicatedNumber`, `pollToken`, and `expiresAt` within 500ms P95 | Integration test |
| AC-2 | Client app contains no long-lived verification signing secret | Static review |
| AC-3 | SMS without `AUTH:` prefix is silently discarded (no Firebase write, no log of body) | Unit test |
| AC-4 | Cloud Function returns `verified: true` only when the authenticator receipt sender matches the requested `userPhone` | Integration test |
| AC-5 | Cloud Function returns 403 for invalid poll token or invalid server-issued challenge token | Integration test |
| AC-6 | Cloud Function returns 429 when IP exceeds 30 requests/minute | Integration test |
| AC-7 | Verified entry is atomically deleted from DB (no replay possible) | Integration test |
| AC-8 | Client app offers SMS failure retry guidance | Manual test |
| AC-9 | `sender` written to RTDB is normalized to E.164 when possible; otherwise the raw non-normalizable sender value is persisted and `checkAuth` returns `mismatch` | Unit test |
| AC-10 | Authenticator APK does not contain `AUTHENTICATOR_ENROLLMENT_SECRET` as a hardcoded `BuildConfig` constant at the time of production deployment | Static review |
| AC-9 | Authenticator service auto-restarts within 5 minutes after being killed | Manual test on OEM device |
| AC-10 | Health endpoint returns `healthy` when an authenticator-role device has pinged within 10 minutes | Integration test |
| AC-11 | Cleanup function deletes entries older than 24 hours | Integration test |
| AC-12 | Clock skew > 5 minutes causes rejection in both authenticator and Cloud Function | Unit test |
| AC-13 | Authenticator app requests RECEIVE_SMS, READ_SMS, WAKE_LOCK, FOREGROUND_SERVICE, SCHEDULE_EXACT_ALARM, USE_EXACT_ALARM, POST_NOTIFICATIONS permissions | Manual review of AndroidManifest.xml |
| AC-14 | Battery level is correctly read and written to `/health/{androidId}` on each FCM ping | Integration test |
| AC-15 | RTDB security rules reject verification writes from identities without `auth.token.role == 'authenticator'` | Unit test against Firebase emulator |

## Session code collision analysis
- Session code format: 10 uppercase hex characters → 16^10 = 1,099,511,627,776 (≈1.1 trillion) possible codes
- Daily volume: 200 verifications
- Birthday problem probability of at least one collision in a single day:
  P ≈ 1 - e^(-200² / (2 × 1.1T)) ≈ 1.8 × 10⁻⁸ (0.0000018%)
- **Conclusion:** Collision risk is negligible. Even at 10,000 verifications/day, the probability is < 0.005%.
- **If collision occurs:** RTDB last-write-wins; the second SMS overwrites the first. The first client's verification would return `pending` (entry replaced). User would need to retry. This is acceptable given the probability.

## Regulatory & privacy considerations
- **PII handled:** Phone numbers (E.164 format) are stored ephemerally in RTDB (deleted within minutes of verification, max 24 hours).
- **SMS content:** Contains session code, timestamp, and HMAC signature — no personally identifiable information beyond what's in the phone number itself.
- **Data residency:** Firebase RTDB region is selectable; choose a region compliant with local data protection requirements (e.g., `asia-southeast1` for Bangladesh users).
- **Data retention:** Maximum 24 hours for unverified entries; verified entries deleted immediately. No long-term storage of phone numbers.
- **Bangladesh context:** The Bangladesh Digital Security Act 2023 and proposed Data Protection Act may apply. This system minimizes data collection by design — phone numbers are verified and immediately discarded.
- **Recommendation:** Consult with legal counsel if deploying in regulated industries (medical apps). Document the ephemeral data handling in your app's privacy policy.
