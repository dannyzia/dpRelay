<!--
AI: This defines how users move through the system. Implement each flow completely including error states.
Read first: 01-PRD.md (for what flows are required), 06-API.md (for the endpoints each step calls), 09-UX-SPEC.md
You must: Implement every path listed, including alternate paths and error states. They are not optional.
You must not: Leave any listed error state unhandled. Redirect a user without a reason listed here.
Human reviews this: YES — agree on flows before building UI.
-->

# User Flows
**Project:** Authenticator

---

## Flow: Phone Number Verification

### Entry points
- Registration screen in ecommerce app
- Checkout screen in ecommerce app (phone required for delivery)
- Patient registration in medical app

### Happy path
1. User enters phone number (e.g. `+88017xxxxxxxx`) in client app
2. Client validates format: non-empty, starts with `+`, ≥ 10 digits
3. Client calls `POST /v4/startVerification` with `{ userPhone }`
4. Cloud Function returns `{ sessionCode, smsBody, dedicatedNumber, pollToken, expiresAt }`
5. Client sends the returned `smsBody` to the returned `dedicatedNumber`
6. Client sends POST to `/v4/checkAuth` with `{ sessionCode, pollToken }`
7. Client polls every 2 seconds, up to 30 seconds
8. On `verified: true`, client shows "✅ Phone verified: {sender}"
9. Client proceeds to next screen (registration complete, checkout continue, etc.)

### Alternate paths

#### SMS send fails (SecurityException / NullPointerException / no SIM)
- At step 5, if `smsManager.sendTextMessage()` throws:
- Show: Retry prompt with a plain error message
- Do: Offer a retry button
- Do not: surface the session code to the user directly

#### Verification pending (SMS not yet received by authenticator)
- At step 7, if response is `{verified: false, status: "pending"}`:
- Continue polling (2s interval)
- Show: "Waiting for verification..." with countdown
- Do not: Show error until timeout

#### Phone number mismatch
- At step 7, if response is `{verified: false, reason: "mismatch"}`:
- Show: "Phone number mismatch. The SMS came from a different number."
- Do: Stay on verification screen, let user re-enter phone number
- Do not: Automatically retry

### Error states
| Trigger | Behavior | User-facing message |
|---------|---------|--------------------|
| SMS send SecurityException | Show retry prompt | "SMS failed. Please try again." |
| SMS send NullPointerException | Show retry prompt | "SIM not ready. Please try again." |
| Cloud Function 429 | Stop polling, show error | "Too many requests. Please wait 60 seconds." |
| Cloud Function 403 | Stop polling, show error | "Invalid signature. Please restart verification." |
| Cloud Function 400 | Stop polling, show error | "Verification expired. Please try again." |
| Network timeout | Continue polling until 30s | "Network error. Retrying..." |
| 30s polling timeout | Stop, show retry option | "Verification timed out. Please try again." |

### Validation rules
| Field | Rules | Error message |
|-------|-------|---------------|
| Phone number | Required, starts with `+`, ≥ 10 digits | "Enter a valid phone number starting with +" |
| (no other user input) | — | — |

### Post-conditions
- Entry deleted from `/verification_requests/{sessionCode}` (atomic delete prevents replay)
- Client app stores verification result locally for session
- No persistent data stored on client

---

## Flow: Authenticator App Setup

### Entry points
- App icon on dedicated phone
- BOOT_COMPLETED broadcast (auto-start)
- App update (MY_PACKAGE_REPLACED broadcast)

### Happy path
1. App launches, requests RECEIVE_SMS and READ_SMS permissions
2. User grants permissions
3. Battery optimization dialog appears — user taps "Open Settings" and allows
4. (If Chinese ROM) Auto-start button — user enables in system settings
5. (If Android 12+) Exact alarm permission — user enables in app settings
6. Foreground service starts, notification shown: "Running 24/7 — Listening for SMS"
7. Authenticator registers once with `POST /v4/registerAuthenticator` and exchanges the enrollment secret for a Firebase custom token
8. Firebase custom auth succeeds (with retry on failure)
9. SMS receiver registered, exact alarm scheduled (5 min), WorkManager scheduled (15 min)

### Error states
| Trigger | Behavior | User-facing message |
|---------|---------|--------------------|
| SMS permission denied | Cannot function — show blocking dialog | "This app needs SMS permission to work." |
| Firebase custom auth fails | Retry every 10 seconds | No user-facing message (service still listens) |
| Wi-Fi disconnected | Firebase SDK queues offline writes | No user-facing message (auto-syncs on reconnect) |
