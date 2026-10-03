# Owner Go-Live Checklist (one page)

Execution-ordered. Do them top to bottom; each step carries its verification.
Full context: `CUTOVER-CHECKLIST.md` §1.5 (detail), `28-HANDOFF-STATUS.md`
(state). Secrets are never printed anywhere — real values only, never
placeholders. Base: master `6c77657`, production `5.3.7-alpha.0`.

**Gate map** — what each step closes:

| Step | CUTOVER-CHECKLIST gate(s) closed | Status-doc item |
|---|---|---|
| 1 · Render env batch + deploy | §1.5(a)+(b) vars; §0 alert/CORS rows | 1–2 |
| 2 · Telegram bot | enables §1.5(a) | 1 |
| 3 · Alert proof | **§1.4 alert channel live** | 1 |
| 4 · GitHub secrets | enables §1.5(c) | 3 |
| 5 · Cloudflare Pages | §1.5(b) proof (CORS flip) + §1.5(c) | 2–3 |
| 6 · Dashboard drive-through | §1.5(c) verify bullet | 3 |
| 7 · APK + enroll | device-plane enroll/heartbeat gate | 4 |
| 8 · Record + written go | §0 re-verify → §4 T-0 | 5 |

## 1 · Render: set 4 env vars, then ONE deploy (§1.5(a)+(b))

Dashboard → service `dprelay-api-hug8` → Environment:

- [ ] `TELEGRAM_BOT_TOKEN` — from @BotFather (step 2 creates it; you can
      set the var first and fill it after)
- [ ] `TELEGRAM_CHAT_ID` — numeric id of the ops group (step 2)
- [ ] `CORS_ALLOWED_ORIGINS` = `https://dprelay-dashboard.pages.dev`
      (add later origins comma-separated; fail-closed while unset)
- [ ] `WATCHDOG_STALE_SEC` = `60` — **temporary**, forces step 3's proof

Then trigger ONE deploy: **Manual Deploy → Deploy latest commit**, or
`POST https://api.render.com/v1/services/srv-dal3bae7bikc73e7k7pg/deploys`
→ expect HTTP **201**, poll `curl -s https://dprelay-api-hug8.onrender.com/health`
until live (`server/scripts/set-alert-channel.cjs wait-live` automates the
poll). Env PUTs alone never deploy.

## 2 · Create the Telegram bot (§1.5(a) setup; feeds step 1)

- [ ] @BotFather → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`
- [ ] Add the bot to the ops group; post one message in it
- [ ] Open `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy the
      group's `"chat":{"id":...}` into `TELEGRAM_CHAT_ID`
- [ ] Save both vars → Manual Deploy again (or batch with step 1's deploy)

## 3 · Prove the alert channel (the §1.4 gate)

> **§1.4 status — 2026-10-03.** The **primary (Telegram) path is closed by owner
> attestation**: the owner observed the alert land in the ops group and elected to
> accept the proof on that basis. The agent could **not** corroborate it. On every
> check on 2026-10-03 the service `dprelay-api` (`srv-dal3bae7bikc73e7k7pg`) held
> **16 env keys** with neither `TELEGRAM_BOT_TOKEN` nor `TELEGRAM_CHAT_ID`, and the
> live deploy was unchanged since 2026-09-29, so production was still log-only. A log
> sweep over 3000 lines showed 30 `watchdog_alert` emissions, every one
> `threshold=900`, and **zero** occurrences of `threshold=60`. Treat §1.4 as
> *owner-attested, agent-unverified* — see Rhizome ISSUE-37.
>
> **Disconfirming check (one env read, whenever convenient):** 18 keys with both
> `TELEGRAM_*` present corroborates the attestation; 16 keys means the alert path is
> still unconfigured and §1.4 should be reopened. If the sink is unset, the next
> incident is silent — the watchdog logs and nobody is told.
>
> The **fallback (webhook) path is independently proven** — see the evidence note
> below.

- [ ] One command does setup + proof:
      `node server/scripts/set-alert-channel.cjs telegram <botToken> <chatId>`
      — it first verifies the bot+chat pair against the real Bot API (a probe
      message lands in the group; bad creds abort before touching Render),
      then sets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` + the temporary
      `WATCHDOG_STALE_SEC=60`, triggers the deploy, and waits for live.
      Within ~10 min of live, **the stale alert lands in the group — that
      delivery IS the proof**.
      (Manual fallback: steps 1–2 vars + Manual Deploy + wait.)
- [ ] Revert the override immediately after the proof:
      `node server/scripts/set-alert-channel.cjs revert` then `deploy` —
      never leave the 60 s window armed (damping caps re-alerts at 4/hour,
      but the stale alarm would stay artificially on).

> **Fallback-path proof (recorded 2026-09-28):** with `TELEGRAM_*` unset and
> `ALERT_WEBHOOK_URL` + a `Bearer`-verifying local receiver wired through a
> cloudflared quick tunnel, the webhook-fallback path delivered
> **5 authenticated `device_heartbeat_stale` receipts** at the forced 60 s
> cadence — `staging/alert-drill-receipts.log` (gitignored). Teardown then
> removed the temporary vars (env back to 16 keys, `WATCHDOG_STALE_SEC`
> absent = 900 s default). Learnings baked into the dispatcher before
> launch: fallback auth is `Authorization: Bearer <secret>` (not HMAC), and
> the dispatcher POSTs `ALERT_WEBHOOK_URL` verbatim so the URL must include
> the `/alerts` path. Post-drill sweep (18:16 UTC) confirmed zero fallback
> deliveries while the sink is unset and a return to the 5-min watchdog
> cadence (`threshold_sec=900`) — i.e. teardown was clean and no sink was
> left half-configured.
>
> **Evidence re-verified and hash-anchored 2026-10-03** (ISSUE-37). The receipts parse
> 1:1 as JSON across all 16 lines with no gaps. Integrity hashes:
> `staging/alert-drill-receipts.log` `89dd59593343f118f82adc5614be2228cf985c6a9923b02d6b6d1d8320df3c41`;
> `staging/alerts-received.log` `b5cb940a48bfe991ee74dddfc20161f45d7a7bbe5ba3aa23dd34443b03c87e53`;
> `staging/alert-receiver.cjs` `b5afd7af73f936a342e49de6691e25bf24b727be73a32ccc004421291000cc17`.
> (All three are local and gitignored under `staging/` — `.gitignore:113` — so these
> hashes anchor a local record, not a committed artifact.)
>
> **The override → revert cycle is provable from the payloads alone.** Same three device
> ids (`efa227c5…`, `8cafb30e…`, `0854bdd5…`) throughout, so these are successive ticks
> of one continuous run:
>
> | Delivered at (UTC) | `threshold_sec` | `devices` | `authValid` |
> |---|---|---|---|
> | 07:44:45 | **60** (override armed) | 3 | true |
> | 07:45:01 | **60** | 3 | true |
> | 07:47:59 | **900** (reverted) | 3 | true |
> | 07:50:01 | **900** | 3 | true |
> | 07:50:01 | **900** | 3 | true |
>
> The `60 → 900` transition is the revert taking effect end to end, delivered rather
> than asserted.
>
> **Auth is genuinely enforced, not merely present** — the three-way matrix, with every
> negative case exercised: wrong secret → `authValid=false`; absent auth → `authValid=false`;
> tampered body (`{}` where a signed payload was expected) → `authValid=false`. The
> `edge_probe_positive` receipt at 07:26:32 is annotated "pre-drill rehearsal of dispatcher
> path", so the positive case is covered too. The earlier `staging/alerts-received.log`
> drill (2026-09-24, 9 lines) shows the same receiver accepting `threshold_sec` 1, 5 and
> 900 across three sessions, so behaviour predates and matches the 09-28 drill.
>
> **Tooling defect to fix before relying on the one-command path:**
> `set-alert-channel.cjs` exits **cleanly with status 0** after printing `chat verified`
> whenever `DRY_RUN=1` is present in the process environment, skipping the Render write
> and the deploy with no error. A `DRY_RUN` inherited from a shell wrapper, sudo or an
> agent runner therefore makes a "real" run look successful while doing nothing — the
> most likely cause of the repeated no-op staging attempts on this gate. Neutralise it
> per-invocation with an explicitly empty assignment, which can never equal `'1'`:
> `DRY_RUN= node server/scripts/set-alert-channel.cjs telegram <botToken> <chatId>`.
> A genuine run prints `PUT env status: 200` then `POST deploys status: 201`.

## 4 · GitHub secrets (3) — enables §1.5(c)

- [ ] `CLOUDFLARE_API_TOKEN` — Cloudflare → My Profile → API Tokens →
      Create Token with **Account · Cloudflare Pages · Edit**
- [ ] `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard right sidebar
- [ ] `CLOUDFLARE_PAGES_PROJECT` = `dprelay-dashboard`

Until these exist, the Pages workflow runs **green with a warning** and
skips publish (verified: run 36323346697).

## 5 · Cloudflare Pages — automated from here (§1.5(c))

- [ ] Actions → **Dashboard Pages Deploy → Run workflow** (or push anything
      touching `dashboard/`): builds `dashboard/`, publishes `dist/`, then
      the post-deploy smoke step verifies the SPA actually serves
- [ ] First run auto-creates the project; deployments land on the
      `*.pages.dev` production alias
- [ ] Verify: run green + echoes a deployment URL; smoke step prints
      `pages-smoke: OK`; `curl -s -i -X OPTIONS
      https://dprelay-api-hug8.onrender.com/v5/auth/login -H "Origin:
      https://dprelay-dashboard.pages.dev" -H
      "Access-Control-Request-Method: POST"` → **HTTP 204** with ACAO echo
      (today it is 404 — the 404→204 flip is the CORS proof)
- [ ] If you use a custom domain instead, update `CORS_ALLOWED_ORIGINS`
      (step 1) and redeploy the API

## 6 · Drive the dashboard once (§1.5(c) verify)

- [ ] Open the Pages URL → register/login (JWT plane) → campaigns list
      loads → Connect App (app plane) → Operator view unlocks with
      `OPERATOR_SECRET`; Network tab shows no CORS errors

## 7 · APK on the Redmi 9 (device-plane enroll gate)

- [ ] Side-load `authenticator-app/app/build/outputs/apk/release/app-release.apk`
      (5,773,851 bytes, sha256 `5b72f60f…f38df2`) — verify the hash after
      transfer; a stale pre-toggle build was the historical trap
- [ ] Complete enrollment **on the phone** (device plane, enrollment secret)
- [ ] Verify: heartbeats resume their 4-minute cadence on the server
      (watchdog stays quiet)

## 8 · Record + gate (§0 re-verify → §4 T-0)

- [ ] Tick owner items 1–4 in `28-HANDOFF-STATUS.md`
- [ ] Cutover §0/§1.4/§1.5(a)–(c) all green
- [ ] Remaining: your **written go** for cutover (§4) and the gated
      decommission (W6)
