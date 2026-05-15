<!--
AI: This is the canonical definition of every domain term used in this project.
Read first: 01-PRD.md (for domain terms introduced in requirements)
You must: Use terms from this glossary consistently across all code, comments, and documents. Never use synonyms for defined terms.
You must not: Introduce a new domain term in code or docs without defining it here first.
Human reviews this: YES — domain terms must be agreed by the team. Ambiguous terms cause bugs.
-->

# Glossary
**Project:** Authenticator

## Domain terms
| Term | Definition | Used in |
|------|------------|--------|
| Session Code | A cryptographically secure random string (10 hex chars) that identifies a single verification attempt. Used as the Firebase RTDB key for O(1) lookup. | SmsReceiver, Cloud Function, PhoneAuthHelper, RTDB key |
| Shared Secret | A secret string (32+ chars) known only to the authenticator app, client apps, and Cloud Function. Used as the HMAC key. Never transmitted in SMS or URLs. In production, avoid embedding it directly in the APK; prefer a remote fetch plus encrypted local storage. | AuthCrypto, config.js, build.gradle, PhoneAuthHelper |
| HMAC Signature | Base64-encoded HMAC-SHA256 of `{timestamp}:{sessionCode}` using the Shared Secret. Proves the request originated from an app that knows the secret. Time-bound and session-specific. | AuthCrypto, SmsReceiver, Cloud Function |
| Signature Chain | Both the client app and authenticator compute the same HMAC. The Cloud Function verifies the signature stored in the DB matches the one sent in the request, proving the DB entry was not tampered with. | Cloud Function (checkAuth) |
| Authenticator Phone | The dedicated Android phone running the Authenticator App 24/7. Plugged into charger, connected to Wi-Fi. Listens for SMS and writes to Firebase RTDB. | All documentation |
| Client App | The ecommerce or medical app on the user's phone. Sends SMS and polls the Cloud Function. | PhoneAuthHelper, docs |
| Dedicated Number | The phone number (SIM) on the Authenticator Phone. Client apps send SMS to this number. | build.gradle, PhoneAuthHelper |
| Clock Skew | The time difference between two devices. The system tolerates up to 5 minutes of skew. Beyond that, HMAC signatures are rejected. | AuthCrypto.CLOCK_SKEW_MS, Cloud Function |
| Atomic Delete | Deleting a verified RTDB entry in a single operation, preventing the same session code from being verified twice (replay attack prevention). | Cloud Function (checkAuth) |
| Keep-Alive | A mechanism to ensure the Authenticator foreground service stays running. Three layers: exact alarm (5 min), WorkManager (15 min), FCM ping. | AlarmKeepAlive, ServiceKeepAliveWorker, AuthFcmService |
| Health Ping | An FCM high-priority message sent to the Authenticator Phone to verify it's alive. The phone responds by writing to `/health/{serial}` in RTDB. | AuthFcmService, Cloud Function (health) |
| Rate Limiting | Per-IP throttling of Cloud Function requests (30 requests per minute). Prevents brute-force discovery of valid session codes. | Cloud Function (checkAuth) |
| Authenticator App | The Android application installed on the dedicated phone. Responsible for receiving SMS, validating HMAC, writing to Firebase RTDB, and reporting health. Do not confuse with "Authenticator Phone" (the physical device). | All documentation |
| Authenticator Phone | The physical Android device running the Authenticator App 24/7. Plugged into charger, connected to Wi-Fi. | All documentation |
| E.164 Format | International phone number format: `+` followed by 7-15 digits (e.g., `+8801712345678`). Used for phone number validation and sender matching. | AuthCrypto, Cloud Function validation, RTDB rules |
| ServerValue.TIMESTAMP | Firebase server-side timestamp (milliseconds since epoch). Used instead of client-provided timestamps for RTDB writes to ensure consistent time references. | SmsReceiver (RTDB write), AuthFcmService (health ping) |
| Foreground Service | An Android service that runs with a persistent notification and is less likely to be killed by the system. The Authenticator App uses `FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING` to stay alive 24/7. | AuthenticatorService, AndroidManifest.xml |
| Doze Mode | Android power-saving state that restricts background activity. The authenticator uses exact alarms and FCM high-priority messages to bypass Doze Mode. | AlarmKeepAlive, AuthFcmService |
| Signature Chain | The verification that the HMAC signature stored in the database matches the expected HMAC. Proves the DB entry was written by the authenticator (not forged). See 02-ARCHITECTURE.md for detailed explanation. | Cloud Function (checkAuth) |
| SMS Retry Guidance | When SMS sending fails, the client app displays retry instructions and allows the user to resend after fixing permissions or network state. | PhoneAuthHelper, Client App UI |

## Abbreviations
| Abbreviation | Full form | Notes |
|-------------|-----------|-------|
| RTDB | Firebase Realtime Database | Not Firestore |
| CF | Cloud Function | Firebase Cloud Functions v2 |
| FCM | Firebase Cloud Messaging | Used for remote wake-up ping |
| HMAC | Hash-based Message Authentication Code | SHA256 variant used throughout |
| SMS | Short Message Service | Standard carrier SMS, not RCS or OTT messaging |
| TTL | Time To Live | 10-minute verification window; 24-hour cleanup window |
| NTP | Network Time Protocol | Used for clock synchronization between devices |
| PII | Personally Identifiable Information | Phone numbers are PII; stored ephemerally |
| SLI | Service Level Indicator | Quantitative measure of service behavior (e.g., verification success rate) |
| SLO | Service Level Objective | Target value for an SLI (e.g., 99% verification success rate) |
| OEM | Original Equipment Manufacturer | Phone manufacturers (Samsung, Xiaomi, Oppo, Vivo, Huawei) that may aggressively kill background services |

## Terms that are NOT used in this project
| Avoid | Use instead | Reason |
|-------|-------------|--------|
| OTP | Session Code | OTP implies one-time-password; we use a session identifier with HMAC |
| Token | HMAC Signature | Token is ambiguous (could mean FCM token, auth token, etc.) |
| 2FA / MFA | Phone Verification | This system verifies phone ownership, not multi-factor authentication |
| Password | Shared Secret | "Password" implies user-facing; Shared Secret is developer-facing |
| Server | Cloud Function | No traditional server — using serverless Firebase Functions |
| API Key | Shared Secret | API Key implies a third-party service key; Shared Secret is internal |
