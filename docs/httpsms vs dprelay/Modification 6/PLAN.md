# Modification 6 — Firebase Exit + httpSMS Parity Plan (dP Relay v5)

| | |
|---|---|
| **Date** | 2026-09-07 |
| **Status** | **APPROVED 2026-09-07** — G1 Render (R1–R6) · G2 TypeScript/Fastify · G4 SQLite+Litestream · G5 full M0–M6 · G7 clean-room accepted by owner. Open: G3 (defaults to general-plane-only), G6 (business-event email, needed only by M6) |
| **Rhizome** | ISSUE-2 |
| **Inputs** | `docs/httpsms vs dprelay/REPORT.md` (with your Mod-1..5 corrections: health **pull endpoint exists**; missing piece = scheduled watchdog + alerting) |
| **Goals** | G1 $0 infrastructure · G2 httpSMS feature parity · G3 keep dP Relay differentiators · G4 zero AGPL contamination |

> ⚠️ **LEGAL (G4):** httpSMS is **AGPL-3.0**. Nothing from `/tmp/kilo/httpsms` may be copied into this proprietary repo — no code, no config, no schema DDL. All parity features are **clean-room**: implemented from public Android/Platform SDK docs, protocol behavior, and our own design. Where our design coincidentally differs (e.g., AES-GCM instead of their AES-CFB), the divergence is deliberate and documented. Delete the local clone after this plan is approved.

---

## 1. Problem statement

1. **Firebase costs.** Cloud Functions v2 deployment requires the Blaze (pay-as-you-go) plan; RTDB/Firestone free quotas (storage, bandwidth, **concurrent RTDB connections**) are the first walls a growing OTP/bulk service hits; egress beyond quota bills monthly. The user wants **completely free**.
2. **Parity gap.** REPORT.md §13.1 lists nine httpSMS capabilities we lack (MMS, missed calls, threads, search, schedules, E2EE, dual-SIM, published SDKs, websocket/realtime, email alerts).
3. **Watchdog gap (rescoped).** Per your correction: a **pull endpoint** on `/health/{androidId}` already exists. What's missing is a **scheduled checker + alerting** when `lastPing` goes stale. Cheap to add on any target infra.

## 2. What "completely free" honestly means

| Stays free forever | Becomes free after this plan | Was free, we lose nothing |
|---|---|---|
| **FCM push** (unlimited, no Blaze needed for Admin SDK send) — keep it | API server, DB, web hosting, jobs (§4) | Android SMS APIs |
| Android SDK / Kotlin toolchain | Auth (self-hosted JWT) | bKash/Nagad payment SMS ingest |
| Cloudflare Pages (static hosting) | OpenAPI docs generation | — |

Free ≠ risk-free. The three real trade-offs, accepted explicitly:

- **T1 — durability:** a single free VM is a SPOF. Mitigation: continuous WAL backup (Litestream → Cloudflare R2 free tier) + a scripted 30-minute rebuild (IaC) onto any alternative host.
- **T2 — reclaim/idle policies:** some free tiers reclaim idle resources or cap capacity per region. Mitigation: heartbeat traffic (our own watchdog!) is a natural keep-alive; backups make reclamation an inconvenience, not a disaster.
- **T3 — no free email at scale:** alert/notification email needs SMTP. Options in §13 (G6). Webhook alerting is free and covers the P0 case.

> ⚠️ **FLAG:** Free-tier quotas change. Every number in §4 must be re-verified against provider pages on the day of M0 sign-up. This plan encodes the *structure* of the decision, not immutable quota math.

## 3. Target architecture (v5) — "own the server, keep the push"

Same shape as the httpSMS self-host topology (it is the proven pattern for this exact product class), implemented clean-room in our stack:

```
Consumer apps (Kotlin SDK / any HTTP client)
  │ REST + webhooks (+ optional SSE/WS)          web dashboard (React SPA on Cloudflare Pages)
  ▼                                                    │ JWT
┌────────────────────────── dP Relay v5 server ─────────┴──────────────┐
│ Fastify API (TS)  ·  SQLite (WAL) + FTS5  ·  job runner (node-cron) │
│ auth: users table (Argon2) + JWT  ·  devices: API keys              │
│ kill switch · billing/bKash reconcile · campaigns · OTP HMAC plane  │
│ webhook signer + failure queue · heartbeat watchdog (NEW, P0)       │
└───────────────┬─────────────────────────────────────┬───────────────┘
                │ FCM data message (wake+fetch)        │ REST receipts
                ▼                                     │
      Dedicated Android phone ────────────────────────┘
      FCM wake → GET /v5/messages/outstanding → SmsManager (SIM-selectable)
      sent/delivered broadcasts → REST · inbound SMS/MMS/missed-call → REST
      bKash/Nagad payment SMS → REST · periodic heartbeat → REST
      optional per-app E2EE (general messages ONLY — never the OTP plane)
```

**Why this shape:** the phone stops holding a persistent RTDB socket and becomes pull-based (FCM wake → fetch outstanding → POST results), which is precisely what removes our 100-connection RTDB ceiling and our per-invocation billing exposure.

**The polling inversion (cost keystone):** today `checkAuth` polls every ~2s per waiting user — the single largest invocation/traffic driver. v5 inverts it: the **phone's receipt POST triggers the app webhook server-side**; SDK/dashboard get webhook-first with short-poll fallback only. This must ship in M3 (it is also what makes per-request-billed fallbacks like Cloud Run free tier viable at all).

## 4. Infrastructure decision (G1) — menu + recommendation

| Option | API host | DB | Cold start | Durability | Verdict |
|---|---|---|---|---|---|
| **A (backlog)** | **Oracle Cloud Always Free** — ARM VM (4 OCPU / 24 GB / ~200 GB block), docker-compose, always-on | **SQLite (WAL)** in-VM + **Litestream** → Cloudflare R2 (free) | none | WAL backup every ~1s; scripted rebuild | **Blocked in practice**: signup rejected new account; existing account unusable. Revisit later — host-portable design makes re-adding a config change, not a redesign |
| **B (CHOSEN — G1)** | **Render free web service** (750 instance-hrs/mo, one always-on service) | SQLite behind Litestream restore-on-boot (free tier disk is **ephemeral**) | 15-min idle spin-down → wake in tens of seconds; see R1/R4 | R2 restore-on-boot + continuous replicate | Zero-VM-ops; viable **only with constraints R1–R6 below** |
| C | Cloud Run free tier (2M req/mo class) | no persistent FS → needs Neon/Supabase free Postgres | 1–3s on spin-up; polling must be gone first | Two free dependencies to keep warm | Viable fallback; OK after M3 webhook inversion |
| D | Koyeb free instance | Neon free Postgres | spin-down after idle | same as C | Weakest without the R1 mitigation design |
| E | Home server / mini-PC + Tailscale (free) | SQLite + Litestream | none | physical risk | Valid if hardware exists; decision §13 |

### If G1 = Render — binding design constraints (R1–R6)

- **R1 — Phone heartbeat ≤ 5 min.** Render sleeps free services after 15 min idle. The gateway phone's heartbeat (a real product feature feeding the watchdog) doubles as genuine keep-alive traffic — 5 min gives 3× margin.
- **R2 — Ephemeral disk.** Free tier has no persistent disk: SQLite is restored from R2 on every boot (`litestream restore -if-db-not-exists`) and streamed back continuously. Keep the DB small (aggressive TTLs).
- **R3 — One service, one process.** 750 hrs/mo ≈ exactly one always-on service. API + node-cron + webhook dispatcher + SSE all live in the single Fastify process. Render Postgres is a **90-day trial, then deleted** — do not use it; workers/cron services are paid.
- **R4 — External dead-man switch (required).** If the phone dies, heartbeats stop → Render sleeps → **the in-server watchdog dies with the thing it monitors**. Add a free external pinger (UptimeRobot / cron-job.org, 5-min interval): keeps the service awake AND provides free email alerts when the stack is unreachable.
- **R5 — Cron degrades to at-least-once-on-wake.** node-cron schedules + an on-boot/next-request catch-up sweep for overdue jobs (cleanup, expiry checks, campaign queue), so scheduled work cannot be silently skipped while asleep.
- **R6 — Residual risk.** If R1 *and* R4 both fail, the next OTP request eats a cold start (tens of seconds to minutes). Oracle (A) has no equivalent. This is the entire trade: B = zero VM ops, cold-start tail; A = you run the VM, no tail.

Single-writer SQLite is sufficient: **one gateway phone, one region, low write volume** (short-lived OTP rows, campaign batches). We add FTS5 (search) and strict migrations for free. If multi-phone/multi-region ever arrives, Litestream→Postgres on a paid tier is the escape hatch — a later decision, not now.

Web: React SPA → **Cloudflare Pages** (free, unlimited static bandwidth, preview deploys).

## 5. Component migration map

| Today (Firebase) | v5 replacement | Notes |
|---|---|---|
| Functions v2 (Node) | Fastify (TS) services in `server/` | same language/team; §13 G2 gate if Go preferred |
| RTDB `verification_requests` | `verification_requests` table | TTL via cleanup job |
| RTDB `pending_sms` | `pending_sms` table + FCM wake | phone pulls outstanding |
| RTDB `otp_requests` / `otp_verify_receipts` | `otp_sessions` / `otp_receipts` | hashed OTP + attempts/locked preserved |
| RTDB `health` | `device_health` + **watchdog job** | pull endpoint already exists (your Mod fix); add stale-check + alerts |
| RTDB `payment_sms` | `payment_sms` table | bKash/Nagad parser moves server-side of the phone POST |
| RTDB `registered_apps` / `config` | `apps` / `settings` | kill switch = settings row, same semantics |
| Firestore `app_credits(+usage)`, `transactions`, `packages` | `credits`, `credit_usage`, `transactions`, `packages` | keep refund-on-cancel logic |
| Firestore `bulk_campaigns(+recipients)`, `contactGroups(+phones)`, `messageTemplates` | same-name tables | batch writes → SQLite transactions |
| Firebase Auth (web email/password) | `users` table, Argon2, JWT access+refresh | password reset needs §13 G6 |
| Phone custom token (`role=authenticator`) | device API key in EncryptedSharedPreferences | same storage, new credential type |
| FCM (AuthFcmService) | **unchanged — FCM stays free** | server sends via firebase-admin (FCM only) |
| Firebase Hosting | Cloudflare Pages | SPA + API base URL env |
| Scheduled functions (`cleanupOldRequests`, `processBulkQueue`, `finalizeCompletedCampaigns`, `aggregateStats`) | node-cron in server (+systemd timer redundancy) | add `heartbeat_watchdog`, `message_expiry_check` |
| Firestore/RTDB security rules | API-layer authz middleware | single choke point, testable |
| Emulator-based integration tests | in-memory SQLite (better-sqlite3) + supertest | faster than emulators, no Java dep |

## 6. API surface (v5) — carry-over + parity

- **Carried (breaking-window per our 90-day policy):** `startVerification`, `checkAuth` (fallback poll), `registerAuthenticator` (→ device key), `health`, `sendOtp`, `verifyOtp`, `otpStatus`, `sendBulkSms`, `getBulkStatus`, campaign callables → REST, apps/billing/admin → REST, contact groups, templates.
- **New for parity (clean-room):** `messages` (send/receive/outstanding/events/delivery), **`messages:missed-calls`**, **MMS attachments** (store→R2, signed GETs), **`threads`**, **`search`** (FTS5), **`send-schedules`** CRUD, **`heartbeats`** + watchdog alerts, **`webhooks` CRUD** (signed, retry queue — we already have `webhook_failures` semantics), **SSE/WS stream**, **`phones`** (multi-device-ready, `messages_per_minute` server-side back-pressure), **OpenAPI** generated from the TS route schemas.
- **Phone plane:** `POST /v5/device/messages`, `POST /v5/device/heartbeat`, `POST /v5/device/payment-sms`, `GET /v5/device/outstanding`.

## 7. Android app changes (`authenticator-app`)

1. Remove Firebase RTDB/Database SDK; keep **FCM only** (AuthFcmService becomes wake+fetch).
2. `PendingSmsListener` → `OutstandingFetcher`: FCM data message → `GET /device/outstanding` → existing `SmsRateLimiter` pipeline (keep — it's good).
3. Receipts/results → authenticated REST (device key, EncryptedSharedPreferences, ADR-016 unchanged).
4. **New receivers (clean-room from Android SDK docs):** MMS (`WapPush`/MMS parts → files → upload), missed calls (`PhoneStateListener`/`CallScreeningApi` per SDK level), dual-SIM (`SubscriptionManager` → `SmsManager` per-subscription).
5. **E2EE module (general messages only):** AES-256-GCM with per-app passphrase; **structurally excluded from OTP plane** (server must read OTP bodies to verify + meter — REPORT.md §3 trust model).
6. Payment-SMS ingest → REST POST with same validations (`txn_id ^[A-Z0-9]{10}$`, provider ∈ {bkash,nagad}).

## 8. Parity worklist (maps REPORT.md §13.1 → owners in v5)

| # | Feature | Server | Android | Web | Phase |
|---|---|---|---|---|---|
| 1 | Heartbeat watchdog + alerts | job + alert dispatch | — | status card | **M1 (P0)** |
| 2 | Webhook inversion (kill polling) | trigger on receipt | — | SDK docs | **M3 (P0)** |
| 3 | OpenAPI spec | generated | — | docs page | M3 |
| 4 | General send/receive API | routes | outstanding/results | inbox | M3 |
| 5 | Delivery reports/events | events table | existing intents | — | M3 |
| 6 | MMS + attachments | R2 signed URLs | MMS receiver | viewer | M5 |
| 7 | Missed calls | route + event | PhoneState | list | M5 |
| 8 | Dual SIM | phone model | SubscriptionManager | setting | M5 |
| 9 | Threads + search | FTS5 | — | inbox UI | M5 |
| 10 | Send schedules | cron table | — | UI | M5 |
| 11 | Server-side per-phone back-pressure | config | respects queue | setting | M5 |
| 12 | Expiry checks + notify | job | — | — | M5 |
| 13 | SSE/WS realtime | stream route | — | live campaigns | M6 |
| 14 | E2EE (general plane) | pass-through | AES-GCM | optional | M6 |
| 15 | Published SDKs | — | — | — | M6 (Kotlin → GitHub Packages/JitPack, free; TS client → npm) |
| 16 | Email alerts (needs G6) | SMTP adapter | — | — | M6 |
| 17 | Discord/3CX-style integrations | generic webhook covers | — | — | backlog |

**Preserved differentiators (G3):** OTP HMAC challenge plane, hashed-OTP lockout, kill switch, credits/BDT packages, bKash TrxID + `payment_sms` reconciliation, campaign pause/resume/cancel/refund/retry, multi-tenant admin console, BD E.164 normalization, contact groups + templates.

## 9. Data & cutover

- Export: Functions-readable dump of RTDB JSON + Firestore collections → transform script → SQLite seed. Verify counts row-by-row (credits and transactions get a reconciliation report before go-live).
- **Parallel run:** phone app gets a "v5 endpoint" toggle; both planes active through M3–M4; kill switch governs each independently.
- Decommission Firebase only after 30 clean days on v5 (Blaze off, project kept cold for one more 30-day window as archive).

## 10. Phases

| Phase | Exit criteria |
|---|---|
| **M0 decisions + audit** | §13 gates answered; Firebase console usage exported (prove where cost actually accrues); host provisioned; repo layout (`server/`, `web/`, `client/`, `authenticator-app/`) agreed |
| **M1 core** | Fastify + SQLite + users/JWT + device keys + migrations + CI (pr-checks port) + **watchdog job** |
| **M2 phone cutover** | outstanding-fetch via FCM; receipts REST; payment_sms REST; parallel-run toggle on |
| **M3 OTP + inversion** | v4→v5 compat window; webhook-first SDK; OpenAPI; general message API |
| **M4 business plane** | billing/credits/campaigns/groups/templates/admin; data migration + reconciliation |
| **M5 messaging parity** | MMS, missed calls, dual-SIM, threads/search, schedules, back-pressure, expiry |
| **M6 polish + exit** | SSE/WS, E2EE, SDKs publish, email (if G6), Cloudflare Pages live, Firebase decommission, **verified $0 bill** |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Oracle reclaims idle free VM | watchdog self-traffic; Litestream PITR; one-script rebuild to Option B/D |
| Single-VM SPOF | R2 backups (≤1s RPO), healthchecks, runbook |
| Free SMTP unreliable/noisy | webhook alerts are primary; email optional behind adapter |
| AGPL contamination | clean-room rule (§0); code-review gate greps for copied identifiers; delete `/tmp/kilo/httpsms` clone post-approval |
| SDK breaking change | /v4 compat for 90 days per `docs/Plan/06-API.md` policy |
| BD payment-SMS parser drift | golden-file tests of bKash/Nagad SMS fixtures during M2 |
| SQLite under campaign bursts | batched transactions (already batch-oriented); WAL; measured in M4 load test |
| Render monitor-paradox (if G1=B) | phone dies → heartbeat stops → service sleeps → watchdog sleeps | R4 external pinger as dead-man switch + free alert channel |
| R2 overage billing | free tier is not hard-capped; card on file | billing alert at $1 in Cloudflare dashboard; token scoped to one bucket |

## 12. Target monthly cost

| Component | Cost |
|---|---|
| Render free web service (750 hrs/mo, one service) | 0 |
| Cloudflare R2 (backups + attachments) | 0 within free tier (10 GB class) |
| Cloudflare Pages | 0 |
| FCM | 0 |
| Domain renewal | **the only unavoidable line** (existing domain, ~annual) |

## 13. Open decision gates (need your picks — no silent defaults)

- **G1 — Hosting: DECIDED → (b) Render** free web service, constraints R1–R6 binding. Reason: Oracle blocked in practice — new-account creation rejected, existing account unusable (Rhizome decision log, ISSUE-2). Oracle moves to backlog; the Litestream+R2 + single-binary design keeps the server host-portable, so re-enabling Oracle later is a deploy-target change only. Fallbacks: (c) Cloud Run post-M3 · (d) Koyeb · (e) home server + Tailscale.
- **G2 — Server language: DECIDED → (a) TypeScript/Fastify.** Owner: "has to go with my current language." Port `functions/` logic; one language across server + web.
- **G3 — E2EE scope:** (a) general messages only *(recommended — treated as default unless overridden before M6)* · (b) skip entirely · (c) everywhere (breaks OTP verification — not viable).
- **G4 — DB: DECIDED → (a) SQLite + Litestream** (follows from G1=Render ephemeral disk; no objection raised at approval).
- **G5 — Timeline: DECIDED → (a) full M0–M6.** Sequencing preserved: **M4 remains the Firebase-decommission checkpoint** (cutover + 30 clean days → Blaze off); M5–M6 parity continues on Render afterwards, so $0/month arrives at M4 regardless of scope choice.
- **G6 — Email alerts:** (a) skip, webhooks only *(recommended for $0 purity)* · (b) Gmail SMTP (~500/day) · (c) paid provider (breaks $0). *Note: UptimeRobot (R4) already covers uptime email for free; this gate is about business-event email (message-expired, webhook-failed) for M6 parity. Decide before M6.*
- **G7 — Clean-room/AGPL stance: ACCEPTED by owner 2026-09-07** ("our ones will remain proprietary"). Enforcement: httpSMS local clone deleted post-approval; CI grep gate for AGPL-derived identifiers (`com.httpsms`, `NdoleStudio`, `HttpSms`, …); deliberate implementation divergences documented.

## 14. Immediate next actions (upon gate answers)

1. M0 audit: export Firebase usage + cost attribution (functions vs RTDB vs Firestore vs egress) — validates the exit case with numbers.
2. Provision host (G1), create R2 bucket, skeleton `server/` repo with CI ported from `pr-checks.yml`.
3. Rhizome epic split: one issue per phase (M1..M6) with acceptance criteria from §10.
