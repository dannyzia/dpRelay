<!--
AI: This is the API contract. Implement each endpoint exactly as specified. Request/response shapes are non-negotiable.
Read first: 05-DATA-MODEL.md (for field types), 01-PRD.md (for auth requirements), 19-GLOSSARY.md
You must: Return exactly the fields listed. Enforce every validation rule. Handle every listed error code.
You must not: Add undocumented fields to responses. Return stack traces to clients. Skip input validation.
Human reviews this: YES — the API contract is shared with consumers and must not change without versioning.
-->

# API Contract
**Project:** Authenticator
**Base URL:** `https://{region}-{project}.cloudfunctions.net`
**Version:** 4.0

## Authentication model
- `startVerification`: public HTTPS endpoint; no client-held signing secret
- `checkAuth`: poll token sent in JSON body (not URL, not header)
- `registerAuthenticator`: `Authorization: Bearer {AUTHENTICATOR_ENROLLMENT_SECRET}` header
- `health`: `Authorization: Bearer {HEALTH_ADMIN_SECRET}` header
- `cleanupOldRequests`: internal scheduled — no external auth surface
- Invalid poll token on `checkAuth` → 403. Missing/invalid `Authorization` on `registerAuthenticator` or `health` → 403.

## API versioning
- Current version: **4.0**
- The API is versioned via URL path prefix: `/v4/*` = v4. Future breaking changes will use `/v5/*`.
- Non-breaking changes (new optional fields in response) will not change the version.
- **Breaking changes** (field removal, type changes, new required fields) will:
  1. Be documented in `25-CHANGELOG.md`
  2. Deploy on a new URL path
  3. Maintain backward compatibility for 90 days on the old URL

## Rate limiting
- `startVerification` and `checkAuth` are rate-limited per source IP
- `startVerification`: **10 requests per 15 minutes** per IP
- `checkAuth`: **30 requests per minute** per IP
- Rate limit state is in-memory (resets on cold start — see TD-01 in 18-KNOWN-ISSUES.md)
- On limit exceeded: return 429 immediately without touching the database
- **Rate limit headers** (returned on all `startVerification` and `checkAuth` responses):

| Header | Example | Purpose |
|--------|---------|---------|
| `X-RateLimit-Limit` | `30` | Maximum requests per window |
| `X-RateLimit-Remaining` | `27` | Requests remaining in current window |
| `X-RateLimit-Reset` | `1712345738` | Unix timestamp when the window resets |
| `Retry-After` | `45` | Seconds until the client should retry (only on 429) |

## Standard error format
```json
{ "verified": false, "error": "machine_readable_code" }
```

## Standard error codes
| HTTP | `error` field value | Meaning |
|------|---------------------|---------|
| 400 | `bad_request` | Missing field, invalid format |
| 400 | `expired_request` | Verification request already expired |
| 403 | `invalid_poll_token` | Poll token does not match the stored request |
| 403 | `invalid_challenge` | Authenticator receipt challenge does not match the server-issued challenge |
| 403 | `unauthorized_device` | Invalid authenticator enrollment secret |
| 405 | `method_not_allowed` | Non-POST request on a POST-only endpoint |
| 429 | `rate_limited` | IP exceeded 30 requests/minute |
| 500 | `integrity_error` | Verification record is internally inconsistent |

---

## Endpoints

## Idempotency
- **`startVerification`** is not idempotent — each call creates a new verification session.
- **`checkAuth`** is idempotent for `pending`, `mismatch`, and `expired` responses — the same request can be sent multiple times with the same result while the verification record exists.
- **`checkAuth`** is NOT idempotent for `verified: true` — the first successful verification atomically deletes the DB entry. Subsequent requests with the same session code return `expired`.
- **`registerAuthenticator`** is idempotent from the server perspective — issuing a new custom token does not mutate verification data.
- **`health`** is always idempotent (read-only).

**Client behavior:** The client polls `checkAuth` every 2 seconds. This is safe because:
1. Each poll either returns `pending`, `mismatch`, `expired`, or `verified`.
2. Only the `verified` response deletes the verification record.

### POST /v4/startVerification

Create a short-lived verification session and return the SMS payload the client should send.

**Request body**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| userPhone | string | yes | E.164 format: `/^\+[0-9]{7,15}$/` |

**Success: 200 OK**
```json
{
  "sessionCode": "A3F1B9C2E4",
  "smsBody": "AUTH:A3F1B9C2E4:1712345978901:AbCdEf123...",
  "dedicatedNumber": "+88017xxxxxxxx",
  "pollToken": "PoLlToKeN123...",
  "expiresAt": 1712345978901
}
```

**Error responses**
| Code | `error` | Condition |
|------|---------|-----------|
| 400 | `bad_request` | Missing or invalid `userPhone` |
| 429 | `rate_limited` | IP exceeded startVerification limit |

### POST /v4/checkAuth

Verify a phone number by checking if the authenticator received a matching SMS.

**Request body**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| sessionCode | string | yes | `/^[A-Z0-9]{8,16}$/` |
| pollToken | string | yes | Base64 HMAC-SHA256 poll token minted by `startVerification` |

**Validation order (fail fast — stop at first failure)**
1. Method must be POST → 405 if not
2. Both fields present and non-empty → 400 `bad_request` if missing
3. `sessionCode` matches `/^[A-Z0-9]{8,16}$/` → 400 `bad_request` if not
4. Rate limit check by source IP → 429 `rate_limited` if exceeded
5. DB lookup by `sessionCode` → return `expired` if request not found or already deleted
6. Request expiry check (`expiresAt >= now`) → 400 `expired_request` if not
7. Poll token validation with `crypto.timingSafeEqual()` → 403 `invalid_poll_token` if not
8. If no `receipt` child exists → return `pending`
9. Challenge validation → 403 `invalid_challenge` if receipt challenge does not match recomputed challenge
10. `receipt.sender == userPhone` check → return `mismatch` if different
11. Atomic delete + return `verified: true`

**Timeout:** 60 seconds (Cloud Function default). In practice, response time should be <500ms (P95). If the function times out, the client receives a 500 error — client should retry after 2 seconds.

**CORS preflight:** `OPTIONS` requests are handled automatically and return `204 No Content` with appropriate CORS headers. Preflight requests do not count against the rate limit.

**Success: 200 OK — verified**
```json
{
  "verified": true,
  "sender": "+88017xxxxxxxx",
  "sessionCode": "A3F1B9C2E4",
  "processedAt": 1712345678901
}
```

**All responses include these headers:**

| Header | Example | Purpose |
|--------|---------|---------|
| `X-Request-ID` | `550e8400-e29b-41d4-a716-446655440000` | Unique request identifier for debugging |
| `Server-Timing` | `db;dur=12, hmac;dur=3, total;dur=45` | Performance breakdown in milliseconds |
| `Content-Type` | `application/json` | Response format |

**Success: 200 OK — pending** (SMS not yet received by authenticator)
```json
{
  "verified": false,
  "status": "pending"
}
```

**Success: 200 OK — mismatch** (SMS received from wrong number)
```json
{
  "verified": false,
  "reason": "mismatch",
  "sessionCode": "A3F1B9C2E4"
}
```

**Success: 200 OK — expired** (verification request older than 5 minutes or already cleaned up)
```json
{
  "verified": false,
  "reason": "expired",
  "sessionCode": "A3F1B9C2E4"
}
```

**Error responses**
| Code | `error` | Condition |
|------|---------|-----------|
| 400 | `bad_request` | Missing/invalid field or sessionCode format |
| 400 | `expired_request` | Request expired |
| 403 | `invalid_poll_token` | Poll token does not match |
| 403 | `invalid_challenge` | Authenticator receipt challenge does not match |
| 405 | `method_not_allowed` | Not a POST request |
| 429 | `rate_limited` | IP exceeded 30 req/min |
| 500 | `integrity_error` | Verification record inconsistent |

---

### POST /v4/registerAuthenticator

Exchange an authenticator-only enrollment secret for a Firebase custom token used for RTDB writes.

**Auth:** `Authorization: Bearer {AUTHENTICATOR_ENROLLMENT_SECRET}` header (constant-time comparison)

**Request body**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| androidId | string | yes | Non-empty string |
| model | string | yes | Non-empty string |

**Success: 200 OK**
```json
{
  "firebaseCustomToken": "eyJhbGciOiJSUzI1NiIs...",
  "issuedAt": 1712345678901
}
```

**Error responses**
| Code | Condition |
|------|-----------|
| 403 | Missing, empty, or invalid `Authorization` header |

---

### GET /health

Check authenticator device liveness and system queue depth.

**Auth:** `Authorization: Bearer {HEALTH_ADMIN_SECRET}` header (constant-time comparison)

**Logic:**
- Read all `/health` entries; compute `activeDevices` as count where `lastPing >= now - 600_000 ms` (10 min)
- Read `/verification_requests` count for `queueDepth`
- `status = "healthy"` if `activeDevices >= 1` AND `queueDepth <= 100`; else `"degraded"`

**Success: 200 OK — healthy**
```json
{
  "status": "healthy",
  "activeDevices": 1,
  "devices": [
    {
      "device": "Samsung Galaxy A32",
      "lastPing": 1712345678901,
      "battery": 87
    }
  ],
  "queueDepth": 3,
  "timestamp": 1712345678901
}
```

**Success: 200 OK — degraded**
```json
{
  "status": "degraded",
  "activeDevices": 0,
  "devices": [],
  "queueDepth": 15,
  "timestamp": 1712345678901
}
```

**Error responses**
| Code | Condition |
|------|-----------|
| 403 | Missing, empty, or invalid `Authorization` header |

---

### RTDB Trigger: onPaymentSmsReceived

**Type:** RTDB `onCreate` trigger

**Path:** `/payment_sms/{pushId}`

**Secrets:** `RIDE_BACKEND_URL`, `DPRELAY_INBOUND_SECRET`

**Outbound call:**
- POST `{RIDE_BACKEND_URL}/api/payment/sms-confirm`
- Headers: `Content-Type: application/json`, `x-dprelay-secret: {secret}`
- Body: `{ txn_id, amount_bdt, provider, received_at }`

**Response handling:**
- `2xx` → delete RTDB node, return null
- `404` → delete RTDB node (terminal — no matching payment event), return null
- `409` → delete RTDB node (already confirmed), return null
- `5xx` → retain RTDB node, throw → Cloud Functions retry policy fires

**Validation (before outbound call):**
- Discard and delete node if:
  - `txn_id` not matching `/^[A-Z0-9]{10}$/`
  - `amount_bdt` not a positive integer
  - `provider` not in `{ "bkash", "nagad" }`

---

### (Scheduled) cleanupOldRequests

No external endpoint. Triggered by Firebase Scheduler every 24 hours.

**Logic:** Query `/verification_requests` with `orderByChild('createdAt').endAt(now - 86_400_000)`. Delete all returned entries. Log count of deleted entries.

**Requires:** `.indexOn: ["createdAt"]` on `/verification_requests` in Firebase Rules (see 05-DATA-MODEL.md).
