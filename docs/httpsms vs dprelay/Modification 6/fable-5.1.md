# Fable 5.1 — The dP Relay Story
### A self-contained briefing for the builder who arrives with fresh eyes
*You cannot see the codebase. You do not need to. Everything you must know lives in this document.*

---

## Prologue — your mission

You are joining a live product called **dP Relay** (package `com.digitalpapyrus.authenticator`, repo branch `m1-auth-watchdog`). It is a **phone-verification and bulk-SMS platform** for the Bangladeshi market, and it is mid-rebirth: the old version ran entirely on Firebase; the new version (v5) runs on Render + SQLite + Cloudflare R2, and you will build its next milestones.

Three things this fable gives you:
1. **What we were** — the old system, its architecture and features (Part I).
2. **What the rival can do** — the open-source product *httpSMS* that sets our feature benchmark (Part II).
3. **How we are getting there** — the approved migration plan, what is already live, and exactly what you should build next, through milestone v5.1 and beyond (Parts III–V).

Read Part IV and V twice. Parts I–III are context you cannot find anywhere else, because you cannot see the old code.

---

## Part I — What we were (the Firebase years, v4)

### The idea

One cheap Android phone with a Bangladeshi SIM sits plugged in 24/7. It is the **gateway**: it sends and receives real SMS. Everything else — web dashboard, API, billing — talks to that phone through the cloud. Customers' apps verify their users' phone numbers through it (an OTP service), and the owner resells bulk SMS to businesses on prepaid credits paid in Bangladeshi Taka via bKash/Nagad mobile money.

### The old architecture (all Firebase)

- **Backend:** ~40 Node.js 20 functions on **Firebase Cloud Functions v2** in region `asia-southeast1`. Three planes:
  - **Challenge plane (v4):** `startVerification` issues an HMAC-signed challenge the client encodes into an SMS to the gateway number; the gateway phone's app receives the SMS, verifies E.164 normalization, and writes a signed receipt; `checkAuth` confirms with atomic deletion (replay-proof).
  - **OTP plane:** `sendOtp` / `verifyOtp` / `otpStatus` — a classic 6-digit OTP flow authenticated by per-app `appId` + `appSecret`, with OTPs stored **hashed**, attempt counters, lockout, and expiry. There is also a global kill switch in the database that halts all SMS sending instantly.
  - **Bulk plane:** campaigns of up to thousands of recipients with pause / resume / cancel (with automatic credit refund) / retry-failed, plus external `appId`-authenticated endpoints `sendBulkSms` and `getBulkStatus`.
- **Databases:** Firebase Realtime Database for live phone traffic (pending outbound messages, verification sessions, OTP requests, device health, **payment-SMS ingest**, app registry, kill switch) and Cloud Firestore for business state (credit balances and usage audit, transactions, credit packages, bulk campaigns and recipients, contact groups up to 50×10,000 numbers, message templates).
- **The gateway phone (Android, Kotlin):** a foreground service that (a) listens for outbound SMS jobs in the Realtime Database and sends them via the native SMS manager, throttled by a serial rate limiter (one SMS every 5 seconds, with queue-depth visibility), (b) confirms sends and deliveries via system broadcast receivers, (c) receives inbound SMS — including OTP replies **and bKash/Nagad payment-confirmation SMS** (10-character transaction IDs, amounts, provider name) which are ingested to reconcile manual credit purchases, (d) receives high-priority FCM push messages to wake itself, and (e) reports battery/device health to the cloud. Boot receivers, alarms, and a worker keep it alive across reboots.
- **Web dashboard:** React 18 + Vite + Tailwind, 24 pages — customer dashboard (campaigns, credits, buy-credits, invoices, transactions, contact groups, templates, registered apps, API docs, an interactive playground), an **admin console** (approve bKash transactions, manage credit packages, metrics, campaign oversight), and a small marketing/pricing site. Firebase email/password auth.
- **Client SDK:** a Kotlin helper that wraps the verification and OTP flows for the owner's ecommerce and medical apps.
- **Billing:** prepaid credits in **BDT**. The customer sends money by bKash/Nagad, submits the transaction ID, the gateway phone *itself* ingests the provider's confirmation SMS as evidence, and an admin approves the credit. Campaign cancellation refunds credits automatically.

### Why we left

The whole 13-month Firebase bill was **$0.45** — cheap, but structurally non-zero: Cloud Functions v2 *requires* a paid Blaze plan to deploy at all; Secret Manager and Cloud Scheduler charge flat rent just to exist (~$0.35/month forever); the Realtime Database caps concurrent connections; and the client polling model (`checkAuth` every 2 seconds per waiting user) is an invocation-usage treadmill that grows with success. Firebase has since been shut down on this project (billing disabled — the old functions can no longer be redeployed). **Do not build anything against Firebase.**

---

## Part II — What httpSMS can do (the benchmark)

**httpSMS** is an open-source (AGPL-3.0) product with the same physical heart as ours — a dedicated Android phone as an SMS gateway — but mature, general-purpose, and polished. It is the measuring stick for our rebuild. Its capabilities:

- **Send and receive SMS over a clean REST API** (`/v1/messages/send`, receive, list, search), authenticated per user.
- **Delivery reports and a full event pipeline** — every message state change (queued, sent, delivered, failed, expired, retried) becomes a domain event other systems consume.
- **Webhooks with full CRUD** — users register webhook URLs, and inbound messages are forwarded with signed payloads and retry semantics.
- **MMS with attachments** — inbound MMS parts are extracted to files and served through the API.
- **Missed-call forwarding** — the phone reports missed calls as events.
- **Message threads and full-text search** — an inbox-style view of conversations, searchable.
- **Scheduled sends** — messages can be queued for future or recurring delivery.
- **End-to-end encryption** — optional AES-256 encryption with the key kept only on the phone, so even the server cannot read message bodies.
- **Back-pressure** — a per-phone messages-per-minute limit enforced server-side so the SIM is never abused.
- **Heartbeat monitoring** — the phone pings the server periodically; if it goes silent, the server notices and sends alert emails. The infrastructure equivalent of a dead-man switch.
- **Dual-SIM support** — the Android app can pick which SIM sends.
- **Realtime websocket streaming** — clients see message updates live, no polling.
- **Published SDKs** (Go and Node), **OpenAPI/Swagger documentation**, a polished web inbox, Discord and 3CX integrations, email notifications with pretty templates, Redis caching, and a one-command self-host via Docker Compose (Postgres + Redis).
- **Multi-device**: several phones can serve one account, each with its own API key.

**What httpSMS cannot do** — and this is why we are not just cloning it:
- No OTP/verification semantics at all (no challenges, hashed codes, lockout, replay protection).
- No credits/prepaid billing, no invoices, no admin approval workflows — payments go through LemonSqueezy (cards), useless for Bangladesh.
- No multi-tenant admin console, no payment reconciliation, no campaign lifecycle management (their "bulk" is one call, no pause/resume/refund), no contact groups, no message templates, no kill switch.

**Our strategy:** keep everything that is uniquely ours (Part I), adopt everything of theirs worth having, and never copy a line of their code — they are AGPL-3.0, our product is proprietary. Every feature is implemented **clean-room**: from behavior descriptions and public Android SDK documentation only. A repository script (`scripts/agpl-grep.sh`) fails any commit containing their identifiers.

---

## Part III — The pivot (what already happened)

The approved plan (decisions on record): **leave Firebase entirely; target $0/month; reach full httpSMS parity; keep every differentiator.** The new stack:

| Old (Firebase) | New (v5) |
|---|---|
| Cloud Functions v2 (Node 20) | **Fastify server in TypeScript on Render** (free tier, Singapore) |
| Realtime Database + Firestore | **SQLite** (WAL mode, FTS5 for search later) on the server's disk |
| — (ephemeral disk risk) | **Litestream** streams every DB change to **Cloudflare R2** every 15 seconds, and every boot restores the database from R2 before starting |
| Firebase Auth | Own users table, Argon2 hashing, JWT sessions |
| Firebase Hosting | Cloudflare Pages |
| Secret Manager / Scheduler | Render environment variables / node-cron inside the server |
| FCM push | **Kept — it is free unlimited** and the only reliable way to wake the phone |

Six binding constraints came with choosing Render's free tier (memorize these):
1. **R1** — the service sleeps after 15 idle minutes. An UptimeRobot monitor pings `/health` every 5 minutes to keep it awake (already live).
2. **R2** — free tier has **no persistent disk**: every boot restores the DB from R2 (`litestream restore`) before anything starts. The startup script enforces this; never bypass it.
3. **R3** — one service, one process: API + cron + webhooks + streaming all live in a single Fastify app. No paid add-ons.
4. **R4** — UptimeRobot doubles as the external dead-man switch: if the gateway phone dies, its heartbeats stop, the service sleeps, and the *external* pinger (not our own code) still catches the outage and emails you.
5. **R5** — scheduled jobs must tolerate sleep: cron schedules plus a catch-up sweep on boot/first request.
6. **R6** — accepted residual risk: if both keep-alives fail, the next request waits out a cold start (tens of seconds).

This design already survived a real disaster: the old Render account was billing-suspended mid-project, and a fresh service on a brand-new account restored the entire database from R2 in about 1.5 seconds. **The backups work. Do not break them.**

Decisions already made (do not re-litigate): hosting = Render; server language = TypeScript/Fastify; database = SQLite + Litestream; scope = full parity (all milestones); license stance = proprietary with strict clean-room discipline. Still open, deferred: end-to-end encryption applies to **general messages only** (never the OTP plane — the server must read OTP bodies to verify them), and business-event email alerts (uptime email is already covered free by UptimeRobot).

---

## Part IV — Where we stand right now (v5.0, live)

The v5 server is **deployed and healthy** at:

> **`https://dprelay-api-hug8.onrender.com`** — this URL is canonical for all client and phone configuration. Never hardcode it in source; use environment variables.

What exists on it today:
- `GET /health` (deep health: verifies the SQLite file is open and migrated — Render's health check hits this) and `GET /healthz` (shallow).
- A **migration runner**: plain SQL files under `src/migrations/` applied once each, tracked in a `schema_migrations` table, idempotent across boots. Migration 001 seeds a `settings` table with a `kill_switch` row — the same instant-halt semantics the old system had.
- A **validated startup sequence** (`scripts/start-server.mjs`): checks the Litestream config, verifies every referenced environment variable is present (naming any that are missing), restores the database from R2 (tolerating the expected "empty bucket" case on true first boot), then launches replication **supervising the Node server** — if the server dies, replication dies with it and Render restarts everything.
- Tests (vitest) and a build pipeline that compiles TypeScript and copies the SQL migrations into the build output. A script `scripts/agpl-grep.sh` scans the source tree for rival-product identifiers and must pass before any commit.
- **Infrastructure around it:** the new Render account is clean (no billing hold), UptimeRobot keeps it awake and emails on downtime, and the Render API key is wired into the AI tooling so deploys and logs can be inspected programmatically.

What does **not** exist yet — your work, in order:

### The immediate task: unblock and merge PR #1
Branch `m1-auth-watchdog` is open against master with 5 of 6 CI checks green. The failing check exists because `functions/index.js` (the old Firebase code, still in the repo) requires a service-account credential file at import time that only exists on the original developer's machine — so the unit-test job can never pass on a clean checkout. The approved fix is **test-infrastructure only**: add a Jest `moduleNameMapper` entry that redirects that credential path to a committed dummy JSON fixture (the test suites mock the Firebase Admin SDK, so the dummy is never used for a real connection), and create that fixture file with placeholder fields. After that, the job's command must run `npm run test:unit` (the unit-only script), all six checks go green, and the pull request is squash-merged. Its branch carries the first piece of real v5 work: the **watchdog** — server-side detection of a stale gateway phone.

### Then: v5.1 — the phone cutover (M2)
Today the Android gateway app still talks to Firebase. Your job is to move it to the v5 server:
- The app's outbound loop changes from "listen to a Firebase database reference" to **"receive an FCM high-priority data message → `GET /v5/device/messages/outstanding` → send via the existing 5-second serial queue → POST per-message results back"**.
- Inbound SMS receipts, delivery confirmations, **payment-SMS ingestion**, and **heartbeats** all become authenticated REST calls using a long-lived **device API key** stored in Android's encrypted preferences (replacing the old Firebase custom token).
- The server grows the device-plane routes (`/v5/device/...`), the message/event tables, and the FCM sender (the Firebase project stays alive purely for free push delivery).

### After that (subsequent milestones, already approved)
- **M3:** the OTP plane ported onto v5 (hashed OTPs, lockout, kill switch), webhook delivery to consumer apps **inverted to push** (the phone's receipt triggers the webhook — no client polling anywhere), and an OpenAPI specification generated from the route schemas.
- **M4:** credits, BDT packages, bKash transaction reconciliation, campaigns, contact groups, templates, and the admin plane ported; the production data migrated; Firebase decommissioned permanently.
- **M5:** httpSMS parity features — MMS attachments (stored in R2, served by signed URLs), missed-call events, dual-SIM sending, message threads with FTS5 search, scheduled sends, server-side per-phone rate limits, message-expiry checks with notifications.
- **M6:** server-sent-events/websocket realtime, optional end-to-end encryption for general messages (AES-256-GCM, per-app passphrase — structurally excluded from the OTP plane), published SDKs (Kotlin and npm), and the business-email decision.

---

## Part V — The rules you build under

1. **Clean-room, always.** The rival product is AGPL-3.0; ours is proprietary. Never copy their code, config, schema, or identifiers — implement from behavior and public Android platform documentation. Run `scripts/agpl-grep.sh` before committing; a CI gate enforces it.
2. **Secrets never touch git.** The tooling config file `.kilo/kilo.jsonc` contains live API keys — it must never be staged or committed. Server secrets live in Render's environment settings and `.env.example` documents their names only.
3. **The startup script is sacred.** `scripts/start-server.mjs` validates config, restores the database from R2, and supervises the server. Render's disk is ephemeral; without this, every restart is data loss.
4. **One process, one service.** Everything runs inside the single Fastify app on Render's free tier. New background work is cron inside that app plus a catch-up sweep after sleep.
5. **The phone is the keep-alive.** Its ≤5-minute heartbeat (and UptimeRobot) prevent the service from sleeping. Never remove or lengthen them beyond the plan.
6. **Test discipline.** Unit tests must never require real credentials, emulators, or network. The CI job runs the unit-only script; integration tests against emulators are a local luxury.
7. **Commits:** `type(scope): subject` (imperative, ≤72 characters), reference the tracking issue in the body, never mention AI authorship.
8. **When blocked,** write a checkpoint of what is done, what remains, and how to verify — the next builder arrives with fresh eyes and only this fable plus your checkpoints.

---

## Epilogue

A $0.45 product is being rebuilt into a $0.00 product that does everything its rival can do and several things its rival cannot. The gateway phone is still the heart; the cloud around it is now yours to finish. Restore first, replicate always, keep the lights on with a 5-minute heartbeat — and build.

---

## Addendum — Review amendments (Sep 16, binding on all milestones)

An external review of this fable was accepted in part. These amendments are binding:

**Adopted:**
1. **Payment ingestion must be idempotent (M2/M4).** The gateway POSTs each payment SMS with a computed hash/nonce; the server keeps a processed-ID table and ignores repeats. Credits are awarded only through the admin-approval flow on a unique transaction ID — ingestion retry must never double-award, and a payment SMS lost to a crash must be re-ingestible from the phone's inbox.
2. **Litestream sync-interval is 5 seconds** (was 15s). Payment rows deserve a ≤5-second loss window; worst-case R2 Class-A ops stay inside the free tier.
3. **OTP storage design (M3):** per-OTP salt (never a global salt — prevents cross-customer rainbow tables), `attempts` counter, `locked_until` and `expiry` timestamps; verification and attempt-increment run inside `BEGIN IMMEDIATE` transactions to prevent concurrent-verify races. The plaintext OTP never touches disk or logs.
4. **Free-tier telemetry (M2/M3):** log RSS memory warnings above ~400 MB and `/health` p95 latency; sustained load beyond ~100 msgs/min is the trigger to move Render to the $7 starter tier (still ≪ old Firebase trajectory).
5. **Clean-room process (all PRs):** for every httpSMS-inspired feature, write a short behavior spec from public docs *before* coding, write acceptance tests against that spec, and link the spec in the PR description.
6. **M2 sequencing recommendation:** build the inbound path first (SMS → `POST /v5/device/sms/inbound`), then outbound (FCM → outstanding → send → results). The phone owns send timing (its 5s serial limiter stays); the server owns state.

**Rebutted — do not implement:**
- *Self-ping loopback to prevent Render sleep:* Render's idle detection counts inbound traffic through its public edge only; loopback requests are invisible to it. The design already covers the scenario externally — UptimeRobot's 5-minute pings are themselves inbound traffic, so they both keep the service awake and alert on failure, independent of the gateway phone.
- *Deleting `functions/` after PR #1 merges:* `functions/` is the live v4 production system until the M4 cutover. It is removed at decommission, never at CI-green.

**Amendment 2 — external-review corrections (Sep 16, binding):**
1. **Two monitors, two jobs — never conflate them.** UptimeRobot watches *service liveness only*: it cannot detect gateway death, and gateway failure never sleeps the service (the external pings persist). Gateway-death detection belongs to the server watchdog (heartbeat staleness → alert). Its alert channel is an open item — confirm what PR #1's "watchdog alert dispatch" emits to before promising any alert type.
2. **No v4 metadata inside v5 device calls.** Cutover compatibility is the phone-side endpoint *toggle* (v4 via Firebase, v5 via REST, both active in parallel run). v5 messages carry no v4 HMAC/challenge metadata; anti-replay is enforced server-side in v5.
3. **E.164 normalization stays phone-side** (existing, tested gateway code); the server validates but does not re-normalize.
4. **Do not mirror rival API field names** (`send_at`, `sim`, `encrypted`, …). Behavior parity, not naming parity — design v5's own request/response schema (e.g., `scheduled_for`, `sim_slot`, `encrypted`).
5. **FTS5 search (M5) must exclude** OTP challenge/response logs and payment-reconciliation trails — search covers general message history only.
6. **Inbound storage:** keep sender, body, received timestamp; raw PDU is not required.
7. **Facts about the rival must be verified, not assumed** (it stores inbound messages — it does not discard them after webhooks).

---

*— End of Fable 5.1 —*
