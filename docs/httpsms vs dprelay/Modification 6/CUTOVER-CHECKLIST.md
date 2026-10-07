# dP Relay — Production-Flip Checklist (v4 OTP → v5)

**Owner decision point for moving v4 OTP traffic to v5 (PLAN §9–§10, G5).**
Facts below were probed live on **2026-09-23** against Render (`dprelay-api`,
`srv-dal3bae7bikc73e7k7pg`), Firebase (`authenticator-15fb7`), and the running
API. Secrets are never printed — only set/unset state. Re-verify §0 before
executing anything; if reality has drifted, fix this section first.

> **Status refresh 2026-09-25** (post W1–W5, ISSUE-25): §7's kill-switch gap is
> closed (PR #20); the alert channel is now Telegram-first with webhook
> fallback (PR #24) pending owner-side `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
> setup (§1.4 note); the W3 local import baseline is **clean**
> (`docs/Plan/26-V4-IMPORT-RECONCILIATION.md`) and §4 T-0 is now a
> *re-verification* step, not a first import. See
> `docs/Plan/28-HANDOFF-STATUS.md` for the full shipped-state record and the
> decommission precondition list.
>
> **Status refresh 2026-09-27** (ISSUE-26): all five implementation
> workstreams are now review-verified — Rhizome ISSUE-20 through ISSUE-25 are
> approved and **done** (W4 M3 tails, W5 dashboard incl. AC5–AC7, and the
> handoff docs pass included). Remaining before T-0: only the owner-side
> deploy steps in §1.5, then the gated decommission. Master tip `800d1ed`;
> production stays 5.3.7-alpha.0 (docs-only merges since #30).

---

## 0. Ground truth at drafting time (re-verify before cutover)

| Fact | Value | How to re-verify |
|---|---|---|
| v5 production URL | `https://dprelay-api-hug8.onrender.com` | browser / curl |
| v5 live version | `5.3.7-alpha.0` (server parity at `0321a97` #30; master tip `800d1ed` adds docs-only merges #31/#32; deploy **live**) | `curl -s $BASE/health` |
| v5 master ↔ prod parity | `version` in `/health` == `server/package.json` on master | one curl + one `git show` |
| Deploy guard | `deploy-status.yml` active on master pushes (waits for this push's deploy to go `live`, fails after 10 min otherwise) | Actions tab on last merge |
| v4 state | **Not serving**: `…cloudfunctions.net/health` → HTTP **500**; billing **disabled** (`billingEnabled=false`) | curl + `gcloud billing projects describe` |
| Android client | `V5_API_ENABLED=true`, `V5_API_BASE_URL=https://dprelay-api-hug8.onrender.com` already compiled into the gateway build; device plane talks `enroll/heartbeat/outstanding/results/payment-sms/fcm-token` | `app/build.gradle` |
| Render gates | `JWT_SECRET`, `DEVICE_ENROLLMENT_SECRET`, `APP_PROVISIONING_SECRET`, `OPERATOR_SECRET`, `BKASH_PERSONAL_NUMBER`, `FCM_SERVICE_ACCOUNT_JSON`, `BULK_ENABLED`, all R2/Litestream vars **set** | Render API env-vars (names only) |
| Alert channel | **Telegram-first sink shipped but UNCONFIGURED**: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` absent (owner adds them; never placeholders); `ALERT_WEBHOOK_URL` also unset → alerts log-only today. Damping default 900s ⇒ ≤4 re-alerts/hour per dead receiver. | Render API env-vars (names only) + `/docs/json` |
| Dashboard | `dashboard/` SPA review-closed (Rhizome ISSUE-24, PRs #29/#32): auth, campaigns, credits, groups, templates, apps, operator screens. **Not deployed yet** — needs §1.5(b) + §1.5(c). `web/` v4 zombie stays untouched until decommission. | Render env-vars (names only) + Cloudflare Pages dashboard |

> ⚠️ **FLAG:** `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (preferred) and
> `ALERT_WEBHOOK_URL` (fallback) are unset in production. Until one is set, a
> stale-device or webhook-exhaustion alert exists only in Render logs. The
> Telegram sink is live code (PR #24, verified by tests); setting the owner's
> token + chat id and forcing one real alert is the remaining proof.
> Similarly `ALERT_WEBHOOK_SECRET` (optional Bearer for the webhook fallback).

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
# Render env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set (Telegram-first, PR #24);
# ALERT_WEBHOOK_URL is the fallback. After setting them: POST a Render deploy
# (env PUTs alone do NOT deploy — server/scripts/set-alert-channel.cjs) and force
# one real alert (set-stale drill) to prove delivery. Watchdog cron fires every 5 min.
```

### 1.5 Owner-side deploy steps (the only work left before §4)

All three are owner-only actions (Render dashboard / Cloudflare account) — no
code changes remain on the repo side. To set a var: Render dashboard →
`dprelay-api-hug8` → Environment → add/replace → Save. **Env changes alone do
NOT deploy** — trigger a deploy after each batch (Render → Manual Deploy, or
`POST https://api.render.com/v1/services/srv-dal3bae7bikc73e7k7pg/deploys`
with the API key), then `curl -s $BASE/health` until the live deploy is
confirmed (the deploy-status guard only tracks git pushes).
`server/scripts/set-alert-channel.cjs` automates set-vars + deploy + wait-live
for the alert channel.

**(a) Telegram alert sink — §7 gap 2 (alerts are log-only until proven):**
1. Create a bot via @BotFather (note the token); add it to the ops Telegram
   group; post once in the group and read `getUpdates` to get the numeric
   chat id.
2. On Render set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — real values
   only, never placeholders; keep them out of git, chat, and logs.
3. Deploy, then force one real alert (§1.4 set-stale drill; watchdog cron
   fires every 5 min) and confirm it lands in the Telegram group.
   Verify: that delivery **is** the proof — until it happens, §1.4 stays
   open. `ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_SECRET` stay unset (fallback
   deliberately unused).

**(b) CORS allow-list — §7 gap 6 (dashboard SPA is browser-blocked until
set):**
1. On Render set
   `CORS_ALLOWED_ORIGINS=https://dprelay-dashboard.pages.dev`
   (comma-separate extra origins, e.g. a custom domain). Fail-closed:
   unset = no browser origin is allowed; curl/mobile clients unaffected.
2. Deploy, then verify preflight:
   `curl -s -i -X OPTIONS "$BASE/v5/auth/login" -H "Origin:
   https://dprelay-dashboard.pages.dev" -H "Access-Control-Request-Method:
   POST"` → expect HTTP **204** with `access-control-allow-origin` echoing the
   origin.
   **CONFIRMED 2026-10-03 against live production** (`dprelay-api-hug8.onrender.com`):
   - allow-list is set to the single entry `https://dprelay-dashboard.pages.dev`;
   - `OPTIONS /health` with that Origin → **204**,
     `access-control-allow-origin: https://dprelay-dashboard.pages.dev`,
     `access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS`;
   - **negative control** `Origin: https://evil.example` → **204** with **no**
     `access-control-allow-origin` header, i.e. refused. The positive result
     only means something because the unlisted origin is denied.
   The earlier "404 with no CORS headers" note described the fail-closed state
   before the allow-list existed; that state is over and the 404→204 flip has
   happened.
   **Residual gap:** `dprelay-dashboard.pages.dev` does not resolve yet
   (NXDOMAIN) — no dashboard has ever been published, because (c) has never
   gone green. The API therefore allow-lists a correct origin that currently
   serves nothing. CORS is not the blocker; the Pages deploy is.

**(c) Cloudflare Pages deploy — automated (ISSUE-27, workflow
`.github/workflows/dashboard-pages-deploy.yml`):**
1. Set three GitHub Actions secrets (Settings → Secrets and variables →
   Actions): `CLOUDFLARE_API_TOKEN` (Cloudflare Pages — Edit permission),
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT` (e.g.
   `dprelay-dashboard`). No Cloudflare Git integration and no manual build
   config: the workflow builds `dashboard/` (npm ci + tsc + vite) and
   publishes `dist/` via wrangler on every master push touching it, and the
   first run creates the Pages project (production deployments mapped to
   main).
2. After the first green run, note the final origin (default
   `https://dprelay-dashboard.pages.dev` or the custom domain). If it
   differs from the (b) value, update `CORS_ALLOWED_ORIGINS` and redeploy
   the API — which is why (b) comes first.
   **BLOCKED on a Cloudflare token that Cloudflare rejects.** All three
   secrets exist (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_PAGES_PROJECT`; token last rotated 2026-10-02T08:07:27Z), and
   the non-empty check passes, but the workflow's credential preflight fails
   with `code 6003 "Invalid request headers"`, inner `6111 "Invalid format
   for Authorization header"`. Latest failing run **37100586782**
   (2026-10-03T05:40:39Z, `workflow_dispatch`); `master` last attempted
   **36982301978** (2026-10-02T08:07:49Z), also failed.
   **That error is not evidence of a malformed token.** Probing the live
   endpoint shows `6003`/`6111` is Cloudflare's *generic* invalid-token
   response: a 40-char token of the right length, a short one, one with a
   trailing space, and one wrapped in quotes all return the identical code,
   while an absent header returns `1001` (not `9106`) and a wrong-but-
   well-formed token returns `6003` (not `9109`). So the previous reading —
   "the value is malformed" — is unsupported; expired, revoked, wrong-scope
   and wrong-account are all equally consistent, and this run cannot tell
   them apart.
   **Why it cannot yet:** the preflight checks *token verify* before *account
   reachability*, so the account check never executes. That ordering hides
   the one distinction that matters (invalid token vs valid token lacking
   Pages:Edit on this account). Reversing the two checks would make the next
   failure actionable.
   Owner action: mint a fresh token with Account · Cloudflare Pages · Edit and
   replace the secret — see `docs/Plan/29-OWNER-CHECKLIST.md` §4.
3. Drive the dashboard against production: log in (JWT plane), campaigns
   list loads; Connect App (app plane) and Operator views unlock with their
   respective credentials.
   Verify: the Actions run is green and echoes a Pages deployment URL; SPA
   loads from Pages; login works; browser Network tab shows CORS-clean
   responses for every API call.

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

> The step-1 data import (production `--apply`) has a dedicated owner
> procedure: **`docs/Plan/32-FLIP-DAY-IMPORT.md`** — suspend → Litestream
> restore → local apply (rehearsed mechanics) → new replica generation →
> resume, with verification queries and data-level rollback notes.

| # | Step | Verify | Abort if |
|---|---|---|---|
| T-0 | **Re-run the v4 export** → `staging/v4-export-cutover-<date>/` (9 sources, sha256 manifest, contents never printed) and re-reconcile against the **clean local baseline** (`docs/Plan/26-V4-IMPORT-RECONCILIATION.md`: 56 → 29/8/4, every delta rule-based, checksums pinned). Firebase is still readable; the frozen `staging/v4-export-final-2026-09-19/` baseline and its rules stay untouched. **Copy-paste execution sequence: `docs/Plan/31-T0-RUNBOOK.md` (exporter: `server/scripts/export-v4-cutover.cjs`).** Mechanics proven in W3 (ISSUE-22, review-verified); Render offers no direct SSH — run the re-export locally with the documented `staging/` secret files (0600). W1–W5 are review-closed (Rhizome ISSUE-20–25); only §1.5 precedes T-0. | manifest 9/9 hashes; fresh-run reconciliation reproduces §2/§3/§4 of the report | any source unreadable; any NEW unexplained delta vs the baseline rules |
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
- **Alerts** (Telegram-first per §1.5(a); webhook fallback): watchdog `stale_device`, webhook
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

## 7. Residual gaps (fix-before-flip candidates — gaps 1-6 none blocking today; gap 7 is owner-blocking)

1. **Kill switch has no operator route.** ✅ **CLOSED 2026-09-25 (PR #20,
   `0f20194`):** `requireOperator`-gated `POST /v5/admin/kill-switch` shipped
   with tests and deployed. Original finding kept for the record:
   `settings.kill_switch` exists and
   `/v5/otp/send` honors it (`503 sms_paused`), but the only writer is a raw
   DB row (`001_init.sql` seed). Production DB access = Litestream download,
   so the *practical* emergency stop is Suspend Service. A
   `requireOperator`-gated `POST /v5/admin/kill-switch` would close this.
2. **`ALERT_WEBHOOK_URL` unset** — §1.4 gate will fail until set.
   → **SUPERSEDED 2026-09-25 (PR #24):** alerts are Telegram-first
   (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) with webhook fallback; both
   still unset in production, so §1.4 remains open until the owner sets the
   Telegram vars and one real alert is delivered. Owner steps + proof:
   **§1.5(a)**.
   → **§1.4 SPLIT INTO TWO GATES 2026-10-03**, because a single box could only
   ever report the weaker half. **Gate A (credential + membership) is
   owner-verified**: valid token, bot in the ops group, chat id resolves, probe
   delivered. Agent could not corroborate — those credentials have never
   existed on this machine and `staging/` holds no Telegram receipt, so it is
   recorded on the same owner-attested basis as §1.4, not as a sign-off.
   **Gate B (production delivery) is still OPEN**: on every check the service
   held 16 env keys with no `TELEGRAM_*`, the live deploy was unchanged since
   2026-09-29, and a 3000-line log sweep showed 30 `watchdog_alert` emissions,
   all `threshold=900`, zero `threshold=60` — so production never dispatched to
   Telegram and remains log-only. **Gate B does not depend on gate A**: valid
   creds that were never deployed is an ordinary state.
   Settle it with one env read: 18 keys with both `TELEGRAM_*` corroborates the
   attestation and closes gate B; 16 keys means reopen §1.4. Service id is
   `srv-dal3bae7bikc73e7k7pg` (an earlier ISSUE-37 attestation comment
   mistyped it as `...k7kg`; corrected there in comment `01M40N1P7CPKJRZMAJK28TQW9F`).
3. **No staging environment** — prod is the only v5 environment; the canary
   app in §4 step 3 is the staging substitute. Acceptable at this scale, but
   it means every verification happens against real SMS credit.
4. **Single gateway phone** = SPOF. The watchdog detects a stale phone;
   recovery is re-enrolling a replacement (§0 procedure in `11-ENV-VARS.md`).
5. `/health` version is manually bumped per milestone — keep bumping
   `server/package.json` per pass or staleness checks silently degrade.
6. ~~**`CORS_ALLOWED_ORIGINS` unset**~~ — **RESOLVED 2026-10-03.** This gap
   (opened 2026-09-25) blocked the clean-room `dashboard/` SPA (PR #29) from
   calling the API from a browser. The owner set the fail-closed allow-list to
   `https://dprelay-dashboard.pages.dev` on Render and redeployed; the flip is
   live-verified (allowed origin → 204 echoing `access-control-allow-origin`;
   unlisted origin → 204 with no such header). Owner steps: **§1.5(b)**.
   *Residual, and not a CORS problem:* that origin is currently NXDOMAIN,
   because the Pages publish has never succeeded — cause is gap 7 below, not
   CORS. The API is ready for the dashboard the moment the deploy lands.
7. **Cloudflare token gate unresolved — the sole blocker on the dashboard.**
   The dashboard has never been published because `CLOUDFLARE_API_TOKEN` is
   rejected by Cloudflare with `6003` "Invalid request headers" / inner `6111`
   "Invalid format for Authorization header". All three Pages secrets exist and
   the non-empty check passes, so this is not a missing-secret problem.
   **`6003`/`6111` is Cloudflare's generic invalid-token response, not a
   malformed-value signal:** a 40-char token, a short one, one with a trailing
   space and one wrapped in quotes all return the identical code; an absent
   header returns `1001` and a wrong-but-well-formed token returns `6003`.
   Expired, revoked, wrong-scope and wrong-account remain indistinguishable:
   `6003`/`6111` is the same code for all four, so the API cannot name which.
   The preflight now probes **account reachability first**, so a wrong
   `CLOUDFLARE_ACCOUNT_ID` no longer hides behind a token verdict. The
   superseded token-first ordering, and why it was reversed, is recorded as
   **ADR-018** (`docs/Plan/04-ADR.md`).
   The workflow defect is fixed and proven on `docs-load-repro` (project-name
   expansion `6fd5ff3`, credential preflight `86e48c3`); `master` is untouched
   and automatic Pages deploys stay inactive until it lands, since the
   workflow triggers on `push: [master]` only.
   Latest failing run **37100586782** (2026-10-03T05:40:39Z, `workflow_dispatch`).
   **Owner action:** mint a fresh token with Account · Cloudflare Pages · Edit
   and replace the secret — `29-OWNER-CHECKLIST.md` §4. Detail: **§1.5(c)**.

---

*Drafted by Buffy from live probes; secrets handled per `.kilo/kilo.jsonc`
house rules (never printed, temp copies deleted). Tracked under Rhizome
ISSUE-17; 2026-09-27 refresh under ISSUE-26.*
