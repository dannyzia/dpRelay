# dP Relay — Production-Flip Checklist (v4 OTP → v5)

**Owner decision point for moving v4 OTP traffic to v5 (PLAN §9–§10, G5).**
Facts below were probed live on **2026-09-23** against Render (`dprelay-api`,
`srv-dal3bae7bikc73e7k7pg`), Firebase (`authenticator-15fb7`), and the running
API. Secrets are never printed — only set/unset state. Re-verify §0 before
executing anything; if reality has drifted, fix this section first.

---

## 0. Ground truth at drafting time (re-verify before cutover)

| Fact | Value | How to re-verify |
|---|---|---|
| v5 production URL | `https://dprelay-api-hug8.onrender.com` | browser / curl |
| v5 live version | `5.2.0-alpha.0` (= master `2b72c97`, deploy **live**) | `curl -s $BASE/health` |
| v5 master ↔ prod parity | `version` in `/health` == `server/package.json` on master | one curl + one `git show` |
| Deploy guard | `deploy-status.yml` active on master pushes (waits for this push's deploy to go `live`, fails after 10 min otherwise) | Actions tab on last merge |
| v4 state | **Not serving**: `…cloudfunctions.net/health` → HTTP **500**; billing **disabled** (`billingEnabled=false`) | curl + `gcloud billing projects describe` |
| Android client | `V5_API_ENABLED=true`, `V5_API_BASE_URL=https://dprelay-api-hug8.onrender.com` already compiled into the gateway build; device plane talks `enroll/heartbeat/outstanding/results/payment-sms/fcm-token` | `app/build.gradle` |
| Render gates | `JWT_SECRET`, `DEVICE_ENROLLMENT_SECRET`, `APP_PROVISIONING_SECRET`, `OPERATOR_SECRET`, `BKASH_PERSONAL_NUMBER`, `FCM_SERVICE_ACCOUNT_JSON`, `BULK_ENABLED`, all R2/Litestream vars **set** | Render API env-vars (names only) |
| `ALERT_WEBHOOK_URL` | **NOT set** → watchdog + webhook-exhaustion alerts are **log-only** in production | Render API env-vars |

> ⚠️ **FLAG:** `ALERT_WEBHOOK_URL` is unset in production. Until it is set, a
> stale-device or webhook-exhaustion alert exists only in Render logs. Set it
> (any Discord/Slack-compatible receiver) **before** cutover — it is the
> on-call signal for the whole flip. Similarly `ALERT_WEBHOOK_SECRET` (optional Bearer).

> ⚠️ **FLAG (rollback reality):** v4 is **not** a viable rollback target — it is
> already dead (Spark plan, `billingEnabled=false`, gen-2 functions
> undeployable, `/health` 500). Rollback from this cutover means *v5-internal*
> mitigations (§6), not "flip back to Firebase". The parallel-run window
> described in PLAN §9 collapses to: **v5 is the only plane**.

---

## 1. Pre-flight gates (all must pass before any step below)

```bash
BASE=https://dprelay-api-hug8.onrender.com

# 1.1 Server healthy and version-matched to master tip
curl -s "$BASE/health"
# expect: {"status":"healthy",...,"version":"<package.json on master>","db":"ok"}
git show master:server/package.json | grep '"version"'

# 1.2 CI + deploy guard green on the last server-touching merge
gh run list --branch master --limit 5        # expect green deploy-status run

# 1.3 Backup restore-ability proven (RPO/RTO sanity, do NOT skip)
node server/scripts/download-litestream.mjs   # pulls latest replica from R2
# then integrity-check the downloaded DB (sqlite3 pragmas) before trusting DR

# 1.4 Alert channel live
# Render env: ALERT_WEBHOOK_URL set; watchdog cron fires every 5 min
# (watch the receiver for a test alert, or accept log-only knowingly)
```

Gate fails → stop. Fix upstream (deploy chain, backups, alerting) first.
The deploy-status guard exists precisely because this class of failure was
invisible for three merges (ISSUE-13).

---

## 2. One-time provisioning (operator)

Values in this section are **return-once / secret material** — capture them
somewhere safe, never in git or chat.

> Ready-made automation (untracked local scripts, secrets never printed):
> - `node server/scripts/set-production-gates.cjs` — idempotently sets the
>   fail-closed Render gates (`BULK_ENABLED`, `BKASH_PERSONAL_NUMBER`,
>   `OPERATOR_SECRET`, `FCM_SERVICE_ACCOUNT_JSON`, `DEVICE_ENROLLMENT_SECRET`),
>   preserving existing vars. **Already run** — §0 shows all gates set.
> - `node server/scripts/provision-production-app.cjs` — registers the first
>   production app (`dprelay-prod`) and writes the one-time response
>   (appSecret/webhook_secret) to `staging/` with 0600 perms.
>   **Check whether it has already run before re-registering** — a second run
>   mints a *different* app; a run that already happened means the app exists.

```bash
# 2.1 Register a client app (mints appId/appSecret/webhook_secret once) —
#     or run provision-production-app.cjs above:
curl -s -X POST "$BASE/v5/apps/register" \
  -H "Authorization: Bearer $APP_PROVISIONING_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"appId":"<your-app-id>","appSecret":"<client-chosen-secret>","name":"<label>","webhookUrl":"https://your.app/hooks/dprelay"}'
# → response carries appSecret + webhook_secret. webhook_secret is needed in §3
#   to verify X-DP-Signature. There is no re-read endpoint — losing it means
#   rotating the app.

# 2.2 Gateway phone is the device plane (already enrolled under
#     DEVICE_ENROLLMENT_SECRET by the V5_API_ENABLED=true build). Confirm:
curl -s "$BASE/health" | jq '.db'          # server alive
# last_seen freshness: watchdog logs "stale device" if the phone goes quiet;
# a fresh phone = no stale alerts. Optionally watch Render logs for heartbeats.

# 2.3 Credits for the app (v4 parity: request → submit bKash TrxID → approve)
curl -s -X POST "$BASE/v5/billing/credits/request" \
  -H "X-App-Id: <appId>" -H "X-App-Secret: <appSecret>" \
  -H "Content-Type: application/json" \
  -d '{"packageCode":"<code from /v5/billing/packages>"}'
# → shows BKASH_PERSONAL_NUMBER + pending transaction
curl -s -X POST "$BASE/v5/billing/credits/submit-trx" \
  -H "X-App-Id: ..." -H "X-App-Secret: ..." \
  -H "Content-Type: application/json" \
  -d '{"trxId":"<bKash TrxID>"}'
curl -s "$BASE/v5/admin/billing/queue" -H "Authorization: Bearer $OPERATOR_SECRET"
curl -s -X POST "$BASE/v5/admin/billing/approve" \
  -H "Authorization: Bearer $OPERATOR_SECRET" -H "Content-Type: application/json" \
  -d '{"requestId":"<id>"}'    # single-award invariant: one TrxID = one award

# 2.4 Package catalog exists (empty today on prod; the public route is the list,
#     the operator POST is the create)
curl -s "$BASE/v5/billing/packages"
curl -s -X POST "$BASE/v5/admin/billing/packages" \
  -H "Authorization: Bearer $OPERATOR_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"<label>","smsQuota":100,"priceBdt":<n>,"validityDays":<n>}'
```

---

## 3. Client-side bring-up (app owner)

1. Point the SDK at `$BASE` with the `appId`/`appSecret` from §2.1.
2. Register the app's `webhookUrl` (done at provisioning) and keep
   `webhook_secret` server-side **at the client app** for signature checks:
   `X-DP-Signature: hex(HMAC-SHA256(rawBody, webhook_secret))`.
3. Smoke on a phone you own:

```bash
# send (server creates session + queues SMS to gateway phone)
curl -s -X POST "$BASE/v5/otp/send" \
  -H "X-App-Id: ..." -H "X-App-Secret: ..." -H "Content-Type: application/json" \
  -d '{"phone":"+8801XXXXXXXXX"}'          # strict E.164

# verify
curl -s -X POST "$BASE/v5/otp/verify" \
  -H "X-App-Id: ..." -H "X-App-Secret: ..." -H "Content-Type: application/json" \
  -d '{"phone":"+8801XXXXXXXXX","otp":"<code received>"}'

# status (independent read path)
curl -s "$BASE/v5/otp/status?..." -H "X-App-Id: ..." -H "X-App-Secret: ..."
```

4. Confirm the `otp.status` webhook arrived at `webhookUrl` and its signature
   verifies: `openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" < rawbody`.

**Exit criteria for §3:** send→SMS→verify→signed webhook all succeed twice in
a row, and a wrong code is rejected (400-class, attempt counter visible).

---

## 4. Cutover sequence

| # | Step | Verify | Abort if |
|---|---|---|---|
| T-0 | **Re-run the v4 export** → `staging/v4-export-cutover-<date>/` (9 sources, sha256 manifest, contents never printed). Firebase is still readable; this is the reconciliation baseline PLAN §9 requires. | manifest 9/9 hashes | any source unreadable |
| 1 | Provision app + credits (§2) | balance > 0 via `/v5/billing/credits` | approve rejects the TrxID |
| 2 | §3 smoke on a live phone | both flows green | any non-2xx unexplained |
| 3 | **Canary:** point the first (internal/low-traffic) client app at v5 | first real `otp.status` webhook + verify success in production logs | OTP delivery latency or failure spikes |
| 4 | 24 h soak on canary: watch `stats_current` snapshot, Render logs, alert channel | failure rate < 1 %, webhook exhaustion = 0 | failure rate > 10 % → §6 |
| 5 | **Full flip:** remaining client apps move to v5 credentials | each app's first webhook lands | any app cannot receive webhooks |
| 6 | Keep v4 artifacts untouched (functions/ stays; RTDB/Firestore become read-only archive per G5) | — | — |

> ⚠️ **FLAG:** There is no v4-side "stop" lever to pull at flip time (v4 is
> already down) and no per-app traffic percentage switch in v5 — the canary
> granularity is **per client app**, controlled by which apps get v5
> credentials. Sequence canary apps deliberately in step 5.

---

## 5. Post-flip monitoring (30 clean days → Blaze off, per G5)

- **Daily:** `curl -s $BASE/health` (version + `db:ok`).
- **On every push:** `deploy-status.yml` fails the run if the deploy of that
  push doesn't go `live` within 10 min — treat any red run as page-worthy.
- **Alerts** (`ALERT_WEBHOOK_URL`): watchdog `stale_device`, webhook
  `webhook_exhaustion` (after 3 consecutive exhausted dispatches per app).
- **Weekly:** Litestream restore drill (§1.3) — an untested backup is a hope,
  not a backup.
- **Day 30 clean:** freeze v4 export as final archive; schedule Blaze off +
  30-day cold retention of the Firebase project; only then consider deleting
  `functions/` (never before — see fable-5.1 note: `functions/` leaves at
  decommission, never at CI-green).

---

## 6. Rollback plan

**Truth first: v4 cannot take traffic back** (§0). Rollback is about *stopping
harm on v5* and *serving clients another way*, in escalating order:

| Trigger | Action | Time | Who |
|---|---|---|---|
| Single app misbehaving | Revoke/disable that app's credentials (operator DB action); client app falls back to its own error path | minutes | operator |
| Bad deploy (health degraded, spike of 5xx) | **Render → Rollback** to previous live deploy (dashboard one-click); guard run for the bad push will already be red | < 5 min | on-call |
| SMS path compromised / runaway sends | **Render → Suspend Service** (hard stop of all traffic); investigate; resume via Resume | < 2 min | on-call |
| Data corruption suspected | Suspend (above), restore latest Litestream replica to a fresh DB, verify integrity, then redeploy pointing at it | minutes–1 h | on-call |
| Security incident (secret leak) | Suspend + rotate every §0 secret on Render + re-provision apps (§2) + device re-enroll | < 30 min | owner |

Rollback notes:
- The deploy-status guard tracks **`new_commit`** deploys; a manual dashboard
  rollback is a different deploy trigger — check the newest deploy manually
  after any rollback (`curl -s $BASE/health` + Render dashboard), don't wait
  for a green run that isn't coming.
- Client apps should implement **fail-closed** on v5 errors (no SMS is safer
  than wrong SMS); their SDK retry/backoff is the user-visible mitigation
  during any v5 outage.

---

## 7. Residual gaps (fix-before-flip candidates, none blocking today)

1. **Kill switch has no operator route.** `settings.kill_switch` exists and
   `/v5/otp/send` honors it (`503 sms_paused`), but the only writer is a raw
   DB row (`001_init.sql` seed). Production DB access = Litestream download,
   so the *practical* emergency stop is Suspend Service. A
   `requireOperator`-gated `POST /v5/admin/kill-switch` would close this.
2. **`ALERT_WEBHOOK_URL` unset** — §1.4 gate will fail until set.
3. **No staging environment** — prod is the only v5 environment; the canary
   app in §4 step 3 is the staging substitute. Acceptable at this scale, but
   it means every verification happens against real SMS credit.
4. **Single gateway phone** = SPOF. The watchdog detects a stale phone;
   recovery is re-enrolling a replacement (§0 procedure in `11-ENV-VARS.md`).
5. `/health` version is manually bumped per milestone — keep bumping
   `server/package.json` per pass or staleness checks silently degrade.

---

*Drafted by Buffy from live probes; secrets handled per `.kilo/kilo.jsonc`
house rules (never printed, temp copies deleted). Tracked under Rhizome
ISSUE-17.*
