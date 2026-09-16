# dP Relay v5 Server

Fastify + TypeScript + SQLite (WAL). See `docs/httpsms vs dprelay/Modification 6/PLAN.md` for the architecture and `SETUP-R2.md` for backup provisioning.

## Run

```bash
cp .env.example .env   # adjust locally — JWT_SECRET is required (min 32 chars)
npm ci
npm run dev            # tsx watch, http://localhost:3000/health
```

## Test / Build / Start

```bash
npm test        # vitest (uses temp DBs, no env needed)
npm run build   # tsc → dist/ (+ litestream binary + migrations)
npm start       # scripts/start-server.mjs → litestream restore → litestream replicate -exec "node dist/index.js"
```

## Auth (M1)

- `POST /v5/auth/register` — `{ "email", "password" }` → creates user (Argon2id hash)
- `POST /v5/auth/login` — `{ "email", "password" }` → `{ accessToken, refreshToken }`
- `POST /v5/auth/refresh` — `{ "refreshToken" }` → rotated `{ accessToken, refreshToken }`
- `POST /v5/device/heartbeat` — `Authorization: Bearer <device API key>` → updates `last_seen_at`

Device API keys: 32 random bytes, **returned once** at registration, stored as SHA-256 hash only.
All authorization flows through the `requireAuth` (JWT) / `requireDevice` (API key) middleware — the single authz choke point (PLAN §5). Every failure response is structured: `{ ok: false, error, code }`.

## Device plane (M2, PLAN §7)

- `POST /v5/device/enroll` — `Authorization: Bearer <DEVICE_ENROLLMENT_SECRET>`, `{ "label" }` → `{ deviceId, apiKey }` (403 when unconfigured; secret compared in constant time)
- `GET /v5/device/outstanding` — claims up to 50 pending messages; at-least-once via `OUTSTANDING_REQUEUE_SEC` requeue
- `POST /v5/device/results` — `{ "results": [{ "id", "status": "sent"|"failed", "error"? }] }` → terminal update. Accepted results whose message belongs to an OTP session trigger a signed webhook to the owning app (see below).
- `POST /v5/device/payment-sms` — `{ sender, provider: 'bkash'|'nagad', txnId (10 alnum), amountPaisa }` → idempotent by unique `txn_id`
- `POST /v5/device/fcm-token` — `{ "token" }` → stored on the device row (M3 wake sender consumes it)
- `POST /v5/device/heartbeat` — updates `last_seen_at` (feeds the watchdog, doubles as Render keep-alive)

The gateway phone authenticates with its device API key (EncryptedSharedPreferences, ADR-016) on every route except `/enroll`, which takes the enrollment secret.

## OTP webhook dispatch (M3 tail)

When a gateway phone reports a result for an OTP-linked message, the server POSTs a signed notification to the owning app's `webhook_url` (or silently skips apps without one — no webhook configured = no dispatch):

- **Payload** (own field names, not mirrored from any third-party API): `{ kind: "otp.status", appId, sessionId, phone, status: "sent" | "failed" | "verified", timestamp }`
- **Auth**: `X-DP-Signature: hex(HMAC-SHA256(rawBody, webhook_secret))` — verify with the app's webhook secret over the exact raw body. The server must hold the key to sign, which is why `apps.webhook_secret` is plaintext (migration 005).
- **Retry**: 3 attempts total with `WEBHOOK_RETRY_DELAYS_MS` backoff on non-2xx/transport errors; every attempt is recorded in `webhook_deliveries` (attempt number, response code, last error).
- Dispatch failure never fails the phone's results POST — the queue state is already committed; dispatch is a notification.

## Background jobs (R3, R5)

Single Fastify process hosts the node-cron job runner (constraint R3 — one process):

- `heartbeat_watchdog` — devices with `last_seen_at` older than `WATCHDOG_STALE_SEC` (default 15 min) trigger a webhook alert (`ALERT_WEBHOOK_URL`) and a structured log line; log-only when no webhook is configured.
- `catch_up_sweep` — runs on boot and on the **first request after each wake** (Render spin-down guard, constraint R5), so scheduled work cannot be silently skipped while asleep.

All job knobs are env-configurable (see `.env.example`): `WATCHDOG_STALE_SEC`, `WATCHDOG_CRON`, `CATCH_UP_CRON`.

## Render deployment (free web service)

- **Root Directory:** `server`
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- Node version pinned by `.node-version` (20)

## Durability (R1–R2 constraints from the plan)

`npm start` runs `scripts/start-server.mjs`: it validates `litestream.yml` + env vars, runs `litestream restore -if-db-not-exists ./data/dprelay.db`, then boots the API under `litestream replicate -exec` supervision — fresh boot on an empty dir restores the DB from R2 or creates it via migrations. Litestream then streams WAL segments back to R2 continuously.
