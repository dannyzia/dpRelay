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
