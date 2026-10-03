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

## App provisioning (operator)

- `POST /v5/apps/register` — `Authorization: Bearer <APP_PROVISIONING_SECRET>`, `{ "appId", "appSecret", "name"?, "webhookUrl"?, "rateMaxPerPhone"?, "rateWindowSec"? }` → `201 { appId, name, webhookUrl, webhookSecret }`
- Admin app plane — `Authorization: Bearer <OPERATOR_SECRET>`: `POST /v5/admin/apps` (register; appSecret optional → server-generated, return-once), `GET /v5/admin/apps` (list, no secrets), `POST /v5/admin/apps/:id/revoke` / `.../unrevoke` (revoke cuts off every app-plane route instantly — 401 `app_revoked`), `POST /v5/admin/apps/:id/rotate-webhook-secret` (new secret return-once), `PATCH /v5/admin/apps/:id/webhook` (HTTPS-only; empty string clears), `POST /v5/admin/kill-switch` (`{ "enabled": boolean }` — the global SMS pause lever behind `POST /v5/otp/send` without DB access; on = sends reject 503 `sms_paused` while verification keeps working; response reports the previous state and whether it changed).

## Admin device plane (operator)

The device plane had no operator levers at all before this: no route exposed `last_seen_at`, `GET /v5/admin/metrics` reported only a bare `users.devices` count, and `devices.revoked_at` (migration 003) was never written by anything. A stale device could be identified only by reading the alert body, and the only remedy was a direct SQL UPDATE. Both routes are `requireOperator` (`Authorization: Bearer <OPERATOR_SECRET>`; 401 without it, 503 when it is unset).

- `GET /v5/admin/devices` — device rows with **server-resolved** staleness: `stale` and `neverSeen` booleans plus `secondsSinceSeen` are taken from the watchdog's own staleness query, so the list cannot disagree with the alerting path. Query params: `stale=true` (only stale devices), `includeRevoked=true` (default excludes them), `limit` (default 200, max 500). The response also reports the resolved thresholds and counts — `staleThresholdSec`, `alertRepeatSec`, `staleCount`, `neverSeenCount` — so an operator reads the policy from the same call that lists the devices. No secrets are returned: `api_key_hash` never leaves the server.
- `POST /v5/admin/devices/:id/revoke` — sets `revoked_at`, which both `requireDevice` and the watchdog respect immediately. **Idempotent**: a second call returns `200` with `alreadyRevoked: true` rather than an error, so a retried operator script does not have to read state first. A device marked `revocable = 0` (a permanent/hardware device) is refused with `409 device_not_revocable`; unknown id → `404`; malformed id → `400`.

Closes the last hand-INSERT step of the OTP plane: the operator onboards a consumer app in one call. `appSecret` (caller-supplied, min 32 chars) is stored **hash-only**; `webhookSecret` (server-minted) is returned **once** and stored plaintext because the server signs HMAC deliveries (migration 005) — its SHA-256 hash is kept in sync for verifiers. Duplicate `appId` → 409 (never silently overwritten); unset secret → 403 `provisioning_disabled`; per-IP limiter like `/enroll`; `webhookUrl` must be https. Provisioned credentials work immediately on all `requireApp` routes (`X-App-Id` / `X-App-Secret`).

## OTP webhook dispatch (M3 tail)

When a gateway phone reports a result for an OTP-linked message, or an app verifies an OTP via `POST /v5/otp/verify`, the server POSTs a signed notification to the owning app's `webhook_url` (or silently skips apps without one — no webhook configured = no dispatch):

- **Payload** (own field names, not mirrored from any third-party API): `{ kind: "otp.status", appId, sessionId, phone, status: "sent" | "failed" | "verified", timestamp }`
- **Auth**: `X-DP-Signature: hex(HMAC-SHA256(rawBody, webhook_secret))` — verify with the app's webhook secret over the exact raw body. The server must hold the key to sign, which is why `apps.webhook_secret` is plaintext (migration 005).
- **Retry**: 3 attempts total with `WEBHOOK_RETRY_DELAYS_MS` backoff on non-2xx/transport errors; every attempt is recorded in `webhook_deliveries` (attempt number, response code, last error) and logged — a structured `warn` per failed attempt (status code or error object) and an `info` on success. Dispatch failures never fail the triggering request. - **Dead-receiver alerts**: after `WEBHOOK_EXHAUSTION_ALERT_THRESHOLD` (default 3) **consecutive** exhausted dispatches for one app, the shared alert channel fires a `webhook_exhaustion` alert (`appId`, `consecutiveFailures`, `lastSessionId`, `lastError`) — the same channel the heartbeat watchdog uses, and it re-alerts on every further exhaustion while the receiver stays dead. Any successful delivery resets the count (re-arms the alert). With no sink configured the alert is log-only, like watchdog alerts. Sinks: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (preferred, HTML sendMessage via the Telegram Bot API) and `ALERT_WEBHOOK_URL` (generic receiver, also the fallback when Telegram is unconfigured or its delivery fails).

## Background jobs (R3, R5)

Single Fastify process hosts the node-cron job runner (constraint R3 — one process):  - `heartbeat_watchdog` — devices stale past `WATCHDOG_STALE_SEC` (default 15 min) trigger an alert (Telegram sink preferred when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set, else `ALERT_WEBHOOK_URL`) and a structured log line; log-only when no sink is configured. A never-seen device is aged from `created_at` instead (same window — see **Never-seen grace** below).
- `catch_up_sweep` — runs on boot and on the **first request after each wake** (Render spin-down guard, constraint R5), so scheduled work cannot be silently skipped while asleep.

All job knobs are env-configurable (see `.env.example`): `WATCHDOG_STALE_SEC`, `WATCHDOG_ALERT_REPEAT_SEC`, `WATCHDOG_CRON`, `CATCH_UP_CRON`, `BULK_QUEUE_CRON`, `STATS_CRON`.

**Never-seen grace.** Both provisioning routes (`POST /v5/device/register`, `POST /v5/device/enroll`) insert `last_seen_at` as explicit `NULL`, so "no heartbeat yet" and "heartbeat was wiped" look identical. A stale check on `last_seen_at IS NULL` alone therefore marked every device stale from the instant its row was created — a device that enrolled 2 seconds ago and has not heartbeaten yet is not an outage. A never-seen device now gets the **same** grace window as a seen one, measured from `created_at`: stale when `created_at < now - WATCHDOG_STALE_SEC`, compared strictly (`<`, so a device exactly at the boundary is not yet stale). Devices that have heartbeaten keep using `last_seen_at`; revoked devices are excluded from both branches.

**Alert dedupe.** The watchdog used to re-alert on every tick for as long as a device stayed stale — a single dead device produced the same alert every 5 minutes indefinitely, which trains operators to ignore the channel. The tick now dedupes on the **stale set signature** (the sorted device ids): it alerts when the set changes, and re-alerts an unchanged set at most once per `WATCHDOG_ALERT_REPEAT_SEC` (default 3600). Suppressed ticks still emit a structured `watchdog_alert_suppressed_unchanged_set` (`info`, with `deviceIds`, `count`, `suppressedForSec`, `repeatInSec`) so "watchdog is quiet" is distinguishable from "watchdog stopped running". A tick that finds no stale devices clears the baseline, so a device that recovers and then goes stale again alerts immediately rather than waiting out the repeat interval. Dedupe state is process-local and unpersisted, like the sink counters.

**Dead-sink detection.** Alert delivery is best-effort by design — a failing sink must never take the job runner down — which historically made a permanently broken sink look exactly like a healthy one: every tick returned `log-only` and emitted the same per-failure error line, so a dead receiver was indistinguishable from routine noise. Each sink now keeps an in-process consecutive-failure count and emits a distinct, greppable event at the transition: **`alert_sink_degraded`** (`error`, once when the count reaches `ALERT_SINK_FAILURE_THRESHOLD` and again on each further multiple of it, carrying `sink`, `consecutiveFailures`, `threshold`, `degradedSince` and `lastError`) and **`alert_sink_recovered`** (`info`, on the first success after a degradation, carrying how many failures and how long). The two sinks are counted independently, so a dead Telegram does not implicate a healthy webhook fallback. Counters are process-local and unpersisted — the watchdog is a single-process cron (R3), so a restart legitimately starts clean. Alert on `alert_sink_degraded` in your log pipeline; it is the signal that the alerting path itself is broken.

## Bulk campaigns (M4 pass 2, PLAN §10)

App-scoped (requireApp) campaign plane riding the device queue:

- `POST /v5/bulk/campaigns` — create with `sourceType: "csv"` (body `phones`) or `sourceType: "contactGroups"` (body `sourceGroupIds`, max 10 per campaign, per-app scoped; members materialized as recipients at create so later group edits never mutate a running campaign); deducts bulk credits atomically with `bulk_usage` audit rows (hashed phones).
- `POST /v5/contact-groups` / `GET /v5/contact-groups` / `GET|PATCH|DELETE /v5/contact-groups/:id` — per-app contact-group CRUD (v4 stored these in Firestore; v5 makes them first-class) plus `POST|DELETE /v5/contact-groups/:id/phones` for membership (E.164-validated, deduped).
- `POST /v5/message-templates` / `GET /v5/message-templates` / `GET|PATCH|DELETE /v5/message-templates/:id` — per-app message-template CRUD (storage-only; charset/length enforcement happens at campaign create).
- `GET /v5/bulk/campaigns` / `GET /v5/bulk/campaigns/:id` — list (keyset pagination) and status.
- `POST /v5/bulk/campaigns/:id/pause|resume|cancel|retry-failed` — lifecycle; cancel refunds unprocessed recipients **exactly once**; retry-failed re-deducts fresh credits (v4 `retryFailedJobs` parity).
- `GET /v5/bulk/campaigns/:id/recipients/failed` — failure listing for dashboards.

The queue tick (`BULK_QUEUE_CRON`, default every minute) reconciles phone-reported results → retries to `BULK_RETRY_MAX_ATTEMPTS` → enqueues pending recipients under `BULK_SMS_RATE_PER_MINUTE` with `BULK_MAX_PENDING_QUEUE` backpressure and a `BULK_POST_SEND_COOLDOWN_SEC` per-phone cooldown → finalizes completed campaigns with a signed `bulk.campaign.completed` webhook (same `X-DP-Signature` contract as OTP). The whole plane is gated by `BULK_ENABLED` (default **off**); the tick also runs on the wake sweep (R5). The `stats_current` snapshot refreshes on `STATS_CRON` (v4 `aggregateStats` parity).

## Render deployment (free web service)

- **Root Directory:** `server`
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- Node version pinned by `.node-version` (20)
- Auto-deploy on `master` pushes is enabled — a deploy failing there means the
  boot chain broke, not the push chain. `GET /health` reports the running
  `package.json` `version`, so "is production current?" is one curl against
  master's version (ISSUE-13).

## Durability (R1–R2 constraints from the plan)

`npm start` runs `scripts/start-server.mjs`: it validates `litestream.yml` + env vars, runs `litestream restore -if-db-not-exists ./data/dprelay.db`, then boots the API under `litestream replicate -exec` supervision — fresh boot on an empty dir restores the DB from R2 or creates it via migrations. Litestream then streams WAL segments back to R2 continuously.
