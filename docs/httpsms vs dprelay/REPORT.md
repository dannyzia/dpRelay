# httpSMS vs dP Relay — Source-Level Comparison Report

| | |
|---|---|
| **Report date** | 2026-09-07 |
| **Subject A** | [NdoleStudio/httpSMS](https://github.com/NdoleStudio/httpsms) — audited from a `--depth 1` clone at `/tmp/kilo/httpsms` |
| **Subject B** | **dP Relay** (this repo, "Authenticator", package `com.digitalpapyrus.authenticator`) — audited from the working tree |
| **Method** | Pass 1: README-level review (contained errors, see Appendix A). Pass 2: full source audit of both codebases — handlers, entities, listeners, Android sources, security rules, package manifests, CI configs |
| **Status** | Final (pass 2) |

> **Naming note:** "dP Relay" = Digital Papyrus Relay = this repository. The Android gateway package is `com.digitalpapyrus.authenticator`.

---

## 1. Executive Summary

These are **not competing implementations of the same product**. They share exactly one architectural primitive — *a dedicated Android phone acting as an SMS gateway, driven by a cloud API* — and diverge everywhere else:

- **httpSMS** is a mature, general-purpose, **single-tenant-per-account SMS gateway**: send/receive SMS and MMS, missed-call forwarding, message threads, scheduled sends, E2E encryption, webhooks, heartbeat monitoring. Event-driven Go core on Cloud Run/CockroachDB, AGPL-3.0, monetized via LemonSqueezy subscriptions.
- **dP Relay** is a **multi-tenant OTP-verification and bulk-SMS SaaS** for the Bangladeshi market: server-issued HMAC challenges, hashed OTPs with attempt lockout, credit-based billing in BDT reconciled from bKash/Nagad payment SMS, bulk campaign management with pause/resume/refund, app registry with per-app webhooks. Built serverless on Firebase (Functions v2 + RTDB + Firestore), proprietary.

**Where dP Relay is ahead:** verification semantics (HMAC challenges, hashed OTPs, replay protection), monetization (credits, packages, invoices, admin approval), campaign management, payment-SMS reconciliation (`payment_sms`), BD-market localization (bKash/Nagad/BDT, E.164 `+880`), zero-server-ops deployment.

**Where httpSMS is ahead:** messaging depth (MMS attachments, missed calls, threads, search, scheduling), phone-health monitoring with alerting, E2E encryption, realtime websocket streaming, OpenAPI/Swagger docs, dual-SIM, published SDKs, integration ecosystem (Discord, 3CX), battle-tested Go event pipeline with retries and expiry notifications.

The highest-leverage borrow (see §14): a **proactive server-side heartbeat watchdog** — dP Relay collects battery/lastPing to RTDB `/health/{androidId}` and exposes a pull-based `POST /health` endpoint that reads it on demand, but has no scheduled check that proactively alerts when the phone goes silent.

---

## 2. Methodology & Evidence Base

| Source | dP Relay | httpSMS |
|---|---|---|
| Backend code | `functions/index.js` (2,576 lines) + `functions/src/{apps,billing,bulk,jobs,lib}/` | `api/pkg/{handlers,entities,listeners,services,events,...}` (Go) |
| Android code | `authenticator-app/app/src/main/java/com/digitalpapyrus/authenticator/` (14 Kotlin files) | `android/app/src/main/java/com/httpsms/` (28 Kotlin files) |
| Web code | `web/src/pages/{admin,auth,dashboard,marketing}/` (24 pages) | `web/app/` (Nuxt) |
| Rules | `database.rules.json`, `firestore.rules` | SQL schema (CockroachDB / postgres) |
| Client SDK | `client/PhoneAuthHelper.kt` | `httpsms-go`, `httpsms-node` (external repos) |
| Tests | `functions/index.test.js`, jest + Firebase emulators, `e2e/*.spec.js` (Playwright) | per-package `*_test.go` + `tests/` integration suite |
| CI | `.github/workflows/{pr-checks,staging-deploy,production-deploy}.yml` | `.github/workflows/{web,api}.yml` |

Audit limits: httpSMS clone was `--depth 1` (no git history/blame; working tree complete). dP Relay audited from working tree — `functions/` contains emulator debug logs, so local state may drift from the deployed revision.

---

## 3. Positioning

| | dP Relay | httpSMS |
|---|---|---|
| One-liner | OTP verification + bulk SMS SaaS on an operator-owned gateway phone | Personal SMS gateway over HTTP |
| Who owns the gateway phone | **Operator** (one shared device serves all tenants) | **The account owner** (each user's own phone) |
| Tenancy | Multi-tenant (email/password auth, per-uid data, admin role) | Single-tenant per account |
| Target market | Bangladesh (bKash/Nagad/BDT, `+880` E.164 normalization) | Global |
| Consumers | Zia's ecommerce + medical apps via `client/PhoneAuthHelper.kt` SDK | Any HTTP client; Go + Node SDKs published |
| License | Proprietary (all rights reserved) | **AGPL-3.0** (`/LICENSE`) |
| Hosted offering | `authenticator-15fb7.web.app` (Firebase) | `httpsms.com` + self-host via `docker-compose.yml` |

**Trust-model consequence (the deepest difference):** httpSMS can offer E2E encryption because the server never needs to read message bodies — the user's own phone is the gateway. dP Relay's server **must** read OTP bodies to verify challenges and meter credits, so E2EE is architecturally impossible for the OTP plane. This is a design property, not a missing feature.

---

## 4. Architecture

### 4.1 dP Relay

```
Consumer app (ecommerce/medical, Kotlin SDK)
  │  POST /sendOtp, /verifyOtp, /checkOtpStatus  (appId + appSecret)
  ▼
Cloud Functions v2 (Node 20, asia-southeast1)  ← deps: firebase-admin, firebase-functions only
  │  writes /pending_sms/{sessionId}          │  Firestore: campaigns, credits, groups,
  ▼                                           │  templates, transactions, packages
Dedicated Android phone (operator-owned)
  ├─ PendingSmsListener: RTDB ChildEventListener fires
  ├─ AuthFcmService: FCM high-priority wake-up + health report
  ├─ SmsRateLimiter: serialized queue, 5s min interval
  ├─ SmsManager.sendTextMessage + sent/delivered PendingIntents
  ├─ SmsReceiver: inbound SMS → E.164 normalize → receipt to RTDB
  └─ payment SMS ingest: bKash/Nagad txn → /payment_sms
  ▼
RTDB receipt → checkAuth/verifyOtp → atomic delete (replay-safe)
             → webhook (HMAC-signed) to the app's URL
```

- Databases are **split by concern**: RTDB for realtime phone traffic (`pending_sms`, `verification_requests`, `health`, `payment_sms`), Firestore for transactional SaaS state (billing, campaigns, contacts).
- All client-side writes are denied in both rule sets; only the Admin SDK (Cloud Functions) writes. Reads are owner/admin scoped (`firestore.rules`).

### 4.2 httpSMS

```
Client (HTTP / Go / Node SDK)
  │  POST /v1/messages/send
  ▼
Go + Fiber API (Cloud Run; self-host: postgres + redis via docker-compose)
  │  persist → schedule FCM push → 202 Accepted
  ▼
Android phone (account owner's)
  ├─ FirebaseMessagingService: FCM → fetch /v1/messages/outstanding
  ├─ SmsManagerService: send (SIM-selectable) → SentReceiver/DeliveredReceiver
  ├─ Receiver/ReceivedReceiver: inbound SMS + MMS (attachments to temp files)
  ├─ PhoneStateReceiver: missed-call events
  ├─ HeartbeatWorker: periodic POST /v1/heartbeats
  └─ Encrypter: AES/CFB E2EE before upload (optional)
  ▼
Event bus (25+ event types) → listeners: email alerts, Discord, 3CX,
  webhooks, websocket streaming, expiry checks, retries
```

- Single SQL datastore (CockroachDB hosted; `postgres:alpine` + `redis:latest` in `docker-compose.yml` for self-host).
- Domain-event driven (`api/pkg/events/`): `message_phone_delivered`, `message_send_expired`, `phone_heartbeat_offline`, etc., consumed by `api/pkg/listeners/`.

### 4.3 Side-by-side

| | dP Relay | httpSMS |
|---|---|---|
| Backend runtime | Node 20 Cloud Functions v2 | Go + Fiber on Cloud Run |
| Datastores | RTDB + Firestore | CockroachDB (+ Redis cache option) |
| Internal coupling | Direct function calls | CloudEvents-style event bus |
| Server process to manage | None (serverless) | Yes (self-host: docker-compose) |
| Realtime client updates | Polling (`checkAuth`, `otpStatus`) | Websocket listener + polling |
| Runtime dependencies | 2 (`firebase-admin`, `firebase-functions`) | Full Go module graph |

---

## 5. Transport Layer Deep Dive

| Concern | dP Relay | httpSMS |
|---|---|---|
| Outbound trigger | Server writes `/pending_sms/{id}`; phone's RTDB `ChildEventListener` reacts instantly + FCM high-priority wake (`AuthFcmService.kt`) | Server sends FCM; phone pulls via `GET /v1/messages/outstanding` |
| Result reporting | Phone deletes RTDB node on success / writes `error` sub-node; sent+delivered `BroadcastReceiver` | REST: message events, delivery reports |
| Phone→server auth | Firebase custom token, `role=authenticator` claim; enrollment secret entered at runtime (EncryptedSharedPreferences — ADR-016/TD-09) | Email/password login → bearer API key |
| Back-pressure | **Phone-side**: `SmsRateLimiter` serial queue, 5s min interval, queue-depth + ETA APIs | **Server-side**: `messages_per_minute` per phone (`entities/phone.go`) |
| Send timeout | 60s per session, 5-min stale threshold (`PendingSmsListener.kt`) | Per-message expiration duration + scheduled expiry-check events + email on expiry |
| Retry | Campaign-level `retryFailedJobs`; OTP resend via `otpStatus(resend=true)` | Message-level retry events |
| Phone liveness | Health **written** to `/health/{androidId}` (battery, device, lastPing on FCM receive); a pull-based `POST /health` endpoint reads it on demand but **no scheduled watchdog alerts on silence** | `HeartbeatWorker` → `POST /v1/heartbeats` → `heartbeat_monitor` + scheduled checks → **email/Discord alerts on offline** |
| Keep-alive (phone) | Foreground service + `BootReceiver` + `AlarmKeepAlive` + `ServiceKeepAliveWorker` + WAKE_LOCK + exact alarms | Foreground service (`StickyNotificationService`) + BootReceiver + heartbeat |
| Dual SIM | Single dedicated SIM | SIM selection in `SmsManagerService.kt` |
| Kill switch | RTDB `config/sms_paused` → `sendOtp` returns 503 instantly | — |

---

## 6. API Surface

### 6.1 dP Relay (verified in `functions/index.js` + `functions/src/`)

**HTTPS (public / appId-auth):**
- v4 challenge plane: `startVerification`, `checkAuth`, `registerAuthenticator`, `health`
- OTP plane (appId+appSecret, E.164, kill-switch): `sendOtp`, `verifyOtp`, `otpStatus`
- Bulk external (appId+appSecret): `sendBulkSms`, `getBulkStatus`

**Callables (Firebase-auth session):**
- Campaigns: `createBulkCampaign`, `listCampaigns`, `getCampaignStatus`, `pauseCampaign`, `resumeCampaign`, `cancelCampaign` (refunds credits), `retryFailedJobs`, `listFailedRecipients`
- Contacts/templates: `createContactGroup` (≤50 groups × ≤10,000 numbers, dedup, batched writes), `listContactGroups`, `deleteContactGroup`, `listContactGroupPhones` (paginated); `create/list/update/deleteMessageTemplate` (≤100, ≤1600 chars)
- Apps: `registerApp`, `createApp`, `revokeApp`, `regenerateAppSecret`, `updateAppWebhook`, `listApps`
- Billing: `requestCredit`, `approveCredit` (admin), `submitTrxId` (bKash), `getCredits`, `getTransactions`, `getInvoiceHistory`, `upsertPackage`/`listPackages`/`seedPackages` (admin)
- Admin/ops: `setAdminClaim`, scheduled `cleanupOldRequests`, `processBulkQueue`, `finalizeCompletedCampaigns`, `aggregateStats`

**Cross-cutting:** per-IP rate limits with `X-RateLimit-*`/`Retry-After` headers, `X-Request-ID`, `Server-Timing`, POST-only enforcement, versioned `/v4/*` with 90-day compat policy (`docs/Plan/06-API.md`).

### 6.2 httpSMS (verified in `api/pkg/handlers/`)

`messages` (send, bulk-send, receive, search, get, delete, events, outstanding, **calls/missed**), `message-threads` (CRUD), `contacts` (CRUD + CSV upload), `send-schedules` (CRUD), `bulk-messages`, `heartbeats`, `phones` (+fcm-token), `phone-api-keys`, `webhooks` (CRUD), `billing/usage(-history)`, `users/me`, `events`, `attachments/:userID/:messageID/:index/:filename`, LemonSqueezy webhook, Discord + 3CX integration endpoints, Swagger at `/index.html`.

### 6.3 Net

httpSMS has the deeper **message plane**; dP Relay has the deeper **business plane** (verification, credits, campaigns, admin). httpSMS has no OTP/verification API, no credits/packages, no admin console, no pricing/marketing site. dP Relay has no threads/search/scheduling/MMS/missed-calls.

---

## 7. Android Gateway App

| | dP Relay (14 files) | httpSMS (28 files) |
|---|---|---|
| UI | Single enrollment/status screen (`MainActivity`) | Full Compose app (login, inbox-style main, settings, theme) |
| Permissions | RECEIVE_SMS, READ_SMS, SEND_SMS, FOREGROUND_SERVICE(+REMOTE_MESSAGING), WAKE_LOCK, SCHEDULE_EXACT_ALARM, USE_EXACT_ALARM, RECEIVE_BOOT_COMPLETED, INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS | Similar + phone state for missed calls + MMS |
| Inbound | `SmsReceiver` → E.164 normalize (BD formats, TD-10) → signed receipt | `Receiver`/`ReceivedReceiver` → SMS + **MMS w/ attachments** |
| Outbound | `PendingSmsListener` + `SmsRateLimiter` | `SmsManagerService` (SIM-selectable) |
| E2EE | — (impossible by design, §3) | `Encrypter.kt` AES/CFB, key stays on phone |
| Health | Writes RTDB `/health/{androidId}` | `HeartbeatWorker` + server monitoring |
| Crypto hygiene | `AuthCrypto.constantTimeEquals`, runtime-only secrets, hashed OTPs | Password/API-key auth server-side |
| Phone login | Enrollment secret → custom token (no user interaction) | Email/password (`LoginActivity`) |

---

## 8. Web UI

| | dP Relay (React 18 + Vite + Tailwind, 24 pages) | httpSMS (Nuxt + Vuetify) |
|---|---|---|
| Auth | `Login`, `Register` (Firebase email/password) | Firebase email/password + Turnstile |
| Dashboard | 15 pages: campaigns (+detail/create), credits overview/buy, invoices, transactions, contact groups (+detail), templates, apps, API docs, **Playground**, settings | Inbox-style threads, messages, contacts, billing, settings |
| Admin | 6 pages: home, metrics, **ApproveTransactions**, packages, campaign oversight | — (no admin plane) |
| Marketing | Home, Pricing, Contact | Landing page |

dP Relay's Playground + API-docs pages serve SDK consumers; httpSMS's web is an end-user messaging client.

---

## 9. Billing & Monetization

| | dP Relay | httpSMS |
|---|---|---|
| Model | Prepaid **credits**, expiring balances (`app_credits` + usage audit sub-collections) | Subscription + usage metering (`billing_usage`) |
| Packages | Admin-managed, priced in **BDT** (`price_bdt` in `billing/upsertPackage.js`) | LemonSqueezy plans (`lemonsqueezy_handler.go`) |
| Payment | User buys via **bKash/Nagad**, submits TrxID (`billing/submitTrxId.js`); the gateway phone ingests the provider's confirmation SMS into RTDB `/payment_sms` (validates `txn_id` `^[A-Z0-9]{10}$`, `amount_bdt`, `provider∈{bkash,nagad}`) → admin approves (`approveCredit`) | Card via LemonSqueezy webhook |
| Refunds | Automatic credit refund on campaign cancel | — |
| Invoices | `getInvoiceHistory`, Invoices page | Usage history |

**The `payment_sms` pipeline is unique to dP Relay:** the same gateway phone that sends OTPs also acts as a **payment-reconciliation terminal**, closing the loop on manual mobile-money purchases without a payment-gateway integration. httpSMS has no analogue.

---

## 10. Security Model

| Control | dP Relay | httpSMS |
|---|---|---|
| Verification crypto | Server-issued HMAC-SHA256 challenges; constant-time compare; atomic-delete on success (anti-replay); poll tokens | n/a |
| OTP storage | **Hashed** (`otp_requests.hashedOtp` ≥32 chars), attempt counter + `locked` flag, expiry, admin-only reads, client writes denied | n/a |
| DB rules | `database.rules.json` / `firestore.rules`: all writes client-denied; reads scoped to owner/admin; schema `.validate` on every node (E.164, types, enum status) | SQL authz in API layer |
| App credentials | appId + hashed appSecret; revocation; per-app webhook secret (HMAC-signed payloads) | API keys (`phone-api-keys` CRUD) |
| Rate limiting | Per-IP on public endpoints + per-app `rateLimit{maxPerPhone,windowMs}` in `registered_apps` | Per-phone `messages_per_minute` |
| Anti-abuse | Kill switch (`config/sms_paused`), campaign quota/limits | Turnstile on auth |
| Secrets | EncryptedSharedPreferences, runtime-only enrollment secret; functions secrets via Firebase CLI | Env vars |
| E2EE | — (by design, §3) | AES/CFB |
| Exposure hygiene | No stack traces to clients; structured `{ok,error,code}`; POST-only; Log.i/w/e only (TD-09) | Structured errors |

---

## 11. Testing, CI & Operations

| | dP Relay | httpSMS |
|---|---|---|
| Unit | jest (`index.test.js` + modules, coverage) | Go tests per handler/entity/listener |
| Integration | `test:integration` against **Firebase emulators** (firestore, database, auth) | `tests/` suite with emulator adapter, cert generation, own compose |
| E2E | Playwright (`e2e/full-test.spec.js`, `mod4-bulk-sms.spec.js`) | — (web CI instead) |
| Android | `./gradlew test`, ktlint | Instrumented test stubs only |
| CI | `pr-checks.yml`, `staging-deploy.yml`, `production-deploy.yml` | `web.yml`, `api.yml` |
| Local gate | `scripts/run-all-checks.sh`, `pre-commit.sh` | husky (web) |
| Observability | `/health` endpoint, `X-Request-ID`, `Server-Timing` | Heartbeat monitors, email alerts, Scrutinizer, BetterStack |

---

## 12. Master Feature Matrix

| Feature | dP Relay | httpSMS |
|---|:---:|:---:|
| Send SMS via API | ✅ | ✅ |
| Receive SMS via API/webhook | ✅ (OTP receipts + webhooks) | ✅ |
| Delivery reports | ✅ (sent+delivered intents → RTDB → webhook) | ✅ (event pipeline) |
| MMS + attachments | ❌ | ✅ |
| Missed-call forwarding | ❌ | ✅ |
| Message threads/inbox | ❌ | ✅ |
| Message search | ❌ | ✅ |
| Scheduled/recurring sends | ❌ | ✅ |
| Bulk campaigns (pause/resume/cancel/refund/retry) | ✅ | basic `bulk-send` |
| Contact groups (10k) + templates | ✅ | contacts + CSV only |
| OTP verification API | ✅ (challenge + OTP planes) | ❌ |
| Replay protection / hashed OTPs | ✅ | ❌ |
| Webhooks | ✅ per-app, HMAC-signed | ✅ CRUD-managed |
| E2E encryption | ❌ (by design) | ✅ |
| Dual SIM | ❌ | ✅ |
| Phone heartbeat monitoring + alerts | ⚠️ data collected + pull endpoint, no scheduled watchdog | ✅ |
| Kill switch | ✅ | ❌ |
| Credits/billing/invoices/admin approval | ✅ (BDT/bKash/Nagad) | LemonSqueezy only |
| Payment-SMS reconciliation | ✅ | ❌ |
| Multi-tenant + admin console | ✅ | ❌ |
| OpenAPI/Swagger | ❌ (hand-written docs page) | ✅ |
| Published SDKs | Kotlin (in-repo `client/`) | Go + Node (public) |
| Realtime websocket | ❌ (polling) | ✅ |
| Self-host docker | ❌ (Firebase-native) | ✅ |
| Integrations (Discord/3CX) | ❌ | ✅ |
| Email notifications | ❌ | ✅ (hermes templates) |
| CI pipelines | ✅ (3 workflows) | ✅ (2 workflows) |

---

## 13. Gap Analysis

### 13.1 Gaps in dP Relay (vs httpSMS)

1. **No proactive phone-death alerting** — `/health/{androidId}` (battery, lastPing) is written by the Android app and read by a pull-based `POST /health` endpoint, but there is no scheduled watchdog that checks `lastPing` age and fires an alert when the phone goes silent. If the gateway phone dies, OTPs stall silently until an operator manually polls `/health` or users start complaining. httpSMS schedules `phone_heartbeat_check` events and sends email/Discord alerts on offline.
2. **No message-level expiry notifications for the OTP plane's `pending_sms`** — 60s/5min timeouts exist phone-side (`PendingSmsListener`), but the server doesn't schedule expiry checks or notify apps on timeout (webhook `expired` covers OTP sessions, not transport stalls).
3. **No MMS ingest** — BD providers sometimes send config/MMS messages; `SmsReceiver` handles SMS only.
4. **No dual-SIM support** — single `SmsManager` default subscription.
5. **No OpenAPI spec** — `APIDocs.jsx` is hand-maintained; contract drift is possible.
6. **No published SDK artifacts** — `client/PhoneAuthHelper.kt` is in-repo source, not a versioned Maven package.
7. **No realtime push to dashboard** — campaign status is refetched, not streamed (RTDB listener would be trivial since `bulk_progress` already exists).
8. **No email notifications** at all (httpSMS alerts on expiry/failure/heartbeat).
9. **Scheduled sends** — campaigns are immediate; no send-schedules.

### 13.2 Gaps in httpSMS (vs dP Relay)

1. No OTP/verification semantics (no challenges, hashed OTPs, lockout, replay protection).
2. No credits/prepaid billing, packages, invoices, or admin approval workflow.
3. No multi-tenant admin console; no marketing/pricing site beyond a landing page.
4. No payment reconciliation loop (bKash/Nagad SMS ingest).
5. No contact groups > flat contacts; no message templates.
6. No campaign lifecycle (pause/resume/cancel/refund/retry-failed).
7. No kill switch.

---

## 14. Recommendations (prioritized borrow list for dP Relay)

| P | Item | Rationale / sketch |
|---|---|---|
| **P0** | **Heartbeat watchdog** | Scheduled function reads RTDB `/health/*` `lastPing`; if older than N minutes → email + `webhook_failures`-style alert. Data already collected; closes the biggest ops gap. Mirrors httpSMS `heartbeat_monitor` + `phone_heartbeat_offline` events. |
| **P0** | **OpenAPI spec** for the appId plane (`sendOtp`/`verifyOtp`/`sendBulkSms`/`getBulkStatus`) | Machine-readable contract; the API is already externally consumed by `client/`. Generate docs from it instead of `APIDocs.jsx`. |
| P1 | Transport-stall expiry webhooks | Server-side check on `pending_sms` age (>5 min stale) → webhook `failed/expired`, mirroring httpSMS expiry-check events. |
| P1 | Dual-SIM (subscriptionId) | Resilience when one SIM is blocked/out of credit; httpSMS `SmsManagerService` is the reference. |
| P2 | RTDB listener for live campaign progress in dashboard | `bulk_progress` already exists in RTDB; stream it instead of polling. |
| P2 | Publish `client/` to a Maven repository with versioning | Parity with `httpsms-go`/`httpsms-node` consumption model. |
| P2 | MMS ingest (best-effort) | Robustness for `payment_sms` if providers ever send MMS. |
| P3 | Scheduled campaigns | Reuse send-schedule pattern (`message_send_schedule_handler.go`). |
| P3 | Email alerts | Requires SMTP integration decision (dependency — flag before adding). |
| — | E2EE | **Do not adopt** on the OTP plane — the server must read bodies (§3). |

---

## Appendix A — First-Pass Corrections Log

Errors in the pass-1 (README-level) chat analysis, corrected by the pass-2 source audit:

| # | Pass-1 claim | Corrected reality |
|---|---|---|
| 1 | "Receive-only, no outbound SMS" | `PendingSmsListener.kt` sends via `SmsManager` with sent/delivered tracking |
| 2 | "No FCM push; broadcast/poll only" | `AuthFcmService.kt`: high-priority FCM wake-up + health reporting |
| 3 | "No phone-side rate limiting" | `ratelimit/SmsRateLimiter.kt`: 5s serialized queue with depth/ETA |
| 4 | "Single-purpose, one function" | 40+ functions across billing/bulk/apps/jobs + OTP plane |
| 5 | "No webhooks" | `functions/src/lib/webhook.js` (HMAC-signed, per-app) |
| 6 | "No multi-tenancy" | Email/password auth, per-uid rules, admin role + console |
| 7 | "Billing n/a" | BDT packages, bKash TrxID, approvals, invoices, refunds |
| 8 | "httpSMS is MIT; we're open source" | httpSMS is **AGPL-3.0**; dP Relay is proprietary |
| 9 | "No client SDKs" | `client/PhoneAuthHelper.kt` (Kotlin) |
| 10 | httpSMS = README features | Also: MMS, missed calls, dual-SIM, schedules, threads, search, Discord/3CX, websockets, Redis, Swagger |
| 11 | "CI minimal" | 3 GitHub workflows incl. staging + production deploys |

## Appendix B — Evidence Index

**dP Relay:** `functions/index.js` · `functions/src/{apps,billing,bulk,jobs,lib}/` · `database.rules.json` (paths: `verification_requests`, `health`, `registered_apps`, `pending_sms`, `otp_requests`, `otp_verify_receipts`, `payment_sms`, `stats`, `config`, `bulk_progress`, `webhook_failures`) · `firestore.rules` · `authenticator-app/.../{PendingSmsListener,AuthFcmService,SmsReceiver,AuthenticatorService,ratelimit/SmsRateLimiter}.kt` · `AndroidManifest.xml` · `web/src/pages/**` · `client/PhoneAuthHelper.kt` · `functions/package.json` · `.github/workflows/*.yml` · `e2e/*.spec.js` · `scripts/run-all-checks.sh` · `docs/Plan/06-API.md`

**httpSMS:** `api/pkg/handlers/*.go` (route tables) · `api/pkg/events/*.go` · `api/pkg/listeners/*.go` (incl. `websocket_listener.go`, `email_notification_listener.go`) · `api/pkg/entities/{phone,message,billing_usage,contact,...}.go` · `android/.../{SmsManagerService,ReceivedReceiver,PhoneStateReceiver,Encrypter,HeartbeatWorker}.kt` · `docker-compose.yml` (postgres + redis) · `LICENSE` (AGPL-3.0) · `tests/` · README (flows, E2EE, back-pressure, self-host)
