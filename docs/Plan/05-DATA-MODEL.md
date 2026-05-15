<!--
AI: This is the source of truth for the database schema. Implement exactly as specified.
Read first: 01-PRD.md (for entities the product needs), 19-GLOSSARY.md (for correct entity names)
You must: Follow this schema exactly. Keep this doc in sync when schema changes.
You must not: Add fields not listed here. Store timestamps in local time. Use Firestore.
Human reviews this: YES — schema changes require human review before any production migration.
-->

# Data Model
**Project:** Authenticator

## Hard rules
- All data lives in Firebase Realtime Database (NOT Firestore).
- No SQL migrations — schema enforced via Firebase Security Rules (see `docs/03-Firebase-Setup.md`).
- Timestamps stored as Unix milliseconds (UTC). Use `ServerValue.TIMESTAMP` for server-side write time in the authenticator app.
- All entries are ephemeral: verified entries deleted immediately on verification; unverified entries deleted after 24h by cleanup function.
- No soft-delete — all deletes are permanent.

## Entities

### `/verification_requests/{sessionCode}`
Verification request created by the Cloud Function when the client starts a verification session. The RTDB key is the session code itself (enables O(1) lookup by the Cloud Function).

| Field | Type | Required | Written by | Description |
|-------|------|----------|------------|-------------|
| (key) | string | yes | startVerification | Session code (e.g. `A3F1B9C2E4`). Pattern: `^[A-Z0-9]{8,16}$` |
| createdAt | number | yes | startVerification | Server-side creation time via `ServerValue.TIMESTAMP` (ms since epoch, UTC) |
| expiresAt | number | yes | startVerification | Absolute expiry time for the verification challenge (ms since epoch, UTC) |
| userPhone | string | yes | startVerification | Requested phone number in E.164 format (e.g. `+88017xxxxxxxx`) |

#### `/verification_requests/{sessionCode}/receipt`
Authenticator receipt written after a matching SMS is observed on the dedicated phone.

| Field | Type | Required | Written by | Description |
|-------|------|----------|------------|-------------|
| receivedAt | number | yes | SmsReceiver | Server-side write time via `ServerValue.TIMESTAMP` (ms since epoch, UTC) |
| sender | string | yes | SmsReceiver | `originatingAddress` from `SmsMessage`, normalised to E.164 before storage when possible (e.g. `+88017xxxxxxxx`). Carriers in Bangladesh sometimes omit the `+880` prefix; `SmsReceiver` must add it if absent. If the address cannot be normalised, persist the raw carrier-supplied string so `checkAuth` can return `mismatch` rather than `pending` forever. |
| challengeToken | string | yes | SmsReceiver | Server-issued challenge token copied from the SMS body. Cloud Function recomputes and verifies this token. |
| device | string | no | SmsReceiver | `Build.MODEL` of authenticator phone (for diagnostics) |

### `/health/{androidId}`
Liveness and battery data reported by the authenticator phone on each FCM ping. The RTDB key is `Settings.Secure.ANDROID_ID` (stable per app install, no extra permission required — see ADR-006).

| Field | Type | Required | Written by | Description |
|-------|------|----------|------------|-------------|
| (key) | string | yes | AuthFcmService | `Settings.Secure.ANDROID_ID` |
| lastPing | number | yes | AuthFcmService | Server-side ping time via `ServerValue.TIMESTAMP` (ms since epoch, UTC) |
| battery | number | yes | AuthFcmService | Battery percentage (0–100) via `BatteryManager.BATTERY_PROPERTY_CAPACITY`. Returns -1 only if truly unavailable (see ADR-007). |
| device | string | no | AuthFcmService | `Build.MODEL` of authenticator phone |

## Relationships
`/verification_requests` and `/health` are independent — no foreign key relationship.

## Enums (computed, never stored in DB)
| Enum | Values | Computed by |
|------|--------|-------------|
| VerificationStatus | `pending`, `verified`, `expired`, `mismatch` | Cloud Function `checkAuth` response |
| HealthStatus | `healthy`, `degraded` | Cloud Function `health` response |

**`healthy`** = at least one `/health` entry with `lastPing` within the last 10 minutes.
**`degraded`** = no `/health` entries within the last 10 minutes, OR queue depth > 100.

## Indexes
| Path | Field | Type | Reason |
|------|-------|------|--------|
| `/verification_requests` | `createdAt` | `.indexOn` | Cleanup function uses `orderByChild('createdAt').endAt(cutoff)` |
| `/health` | `lastPing` | `.indexOn` | Health endpoint queries devices with recent pings |
| `/rateLimits` | `createdAt` | `.indexOn` | Optional distributed rate limiting table; Cloud Function should write and enforce limits here if scaling past a single instance |

## Firebase Security Rules
Full rules live in `docs/03-Firebase-Setup.md`. Key constraints reproduced here for reference:

```json
{
  "rules": {
    "verification_requests": {
      ".indexOn": ["createdAt"],
      "$sessionCode": {
        ".read": false,
        ".write": false,
        "createdAt": { ".validate": "newData.isNumber()" },
        "expiresAt": { ".validate": "newData.isNumber()" },
        "userPhone": { ".validate": "newData.isString() && newData.val().matches(/^\\+[0-9]{7,15}$/)" },
        "receipt": {
          ".write": "auth != null && auth.token.role === 'authenticator' && !data.exists() && newData.hasChildren(['receivedAt', 'sender', 'challengeToken'])",
          "receivedAt":     { ".validate": "newData.isNumber()" },
          "sender":         { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 32" },
          "challengeToken": { ".validate": "newData.isString() && newData.val().length > 10" },
          "device":         { ".validate": "newData.isString()" },
          "$other":         { ".validate": false }
        },
        "$other": { ".validate": false }
      }
    },
    "health": {
      ".indexOn": ["lastPing"],
      "$deviceId": {
        ".read": false,
        ".write": "auth != null && auth.token.role === 'authenticator'",
        "lastPing": { ".validate": "newData.isNumber()" },
        "battery":  { ".validate": "newData.isNumber()" },
        "device":   { ".validate": "newData.isString()" },
        "$other":   { ".validate": false }
      }
    }
  }
}
```

## Data lifecycle
| Event | Action | Triggered by |
|-------|--------|-------------|
| Verification requested | Create `/verification_requests/{sessionCode}` | Cloud Function `startVerification` |
| Valid, in-time SMS received | Write `/verification_requests/{sessionCode}/receipt` | `SmsReceiver` |
| Verification successful | Atomic delete of `/verification_requests/{sessionCode}` | Cloud Function `checkAuth` |
| Entry older than 24h | Batch delete | Cloud Function `cleanupOldRequests` (daily schedule) |
| FCM ping received | Overwrite `/health/{androidId}` | `AuthFcmService` |
