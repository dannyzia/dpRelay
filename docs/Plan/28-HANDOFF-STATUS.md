# dP Relay — Handoff Status (2026-09-25)

Tracks execution of the owner handoff queue (`docs/httpsms vs dprelay/
Modification 6/fable5-v2.md`, Workstreams 1–6) and records the decommission
preconditions. Complements `docs/httpsms vs dprelay/Modification 6/
CUTOVER-CHECKLIST.md` (the operational flip procedure). Owner decisions and
secret material are never duplicated here — pointers only.

**Production posture:** `https://dprelay-api-hug8.onrender.com` live at
**5.3.7-alpha.0** (master `943d580`), `/docs/json` serving the OpenAPI spec
(45 paths), server suite **173/173**, AGPL gate clean, CI 6/6 on recent
merges, deploy guard active.

## Workstream record

| WS | Scope | Status | Evidence |
|---|---|---|---|
| 1 | M4 pass 3 deferred routes | ✅ Done | Contact groups/templates CRUD (#17 `d196f23`); admin app plane + migration 009 + rotate/revoke/webhook-update (#18 `50a5f0e`); `POST /v5/apps/revoke`, `GET …/credentials-status`, operator `GET /v5/admin/metrics` + `GET /v5/admin/campaigns` (#25 `d3b3873`); operator kill-switch (#20 `0f20194`). Migration 008 audited: spec already satisfied, no duplicate created. ISSUE-20 **done**. |
| 2 | Android parallel-run APK | ✅ Done | #26 `6656179`: `SmsRateLimiter` confirmed a process-wide singleton shared by both planes (regression-locked by `SmsRateLimiterDualPlaneTest`); `V5_SERVER_URL`/`V5_API_ENABLED=true` BuildConfig verified; JDK 17 build green (lint + 49 unit tests + assembleRelease); APK `app-release.apk` 5,773,851 bytes, sha256 `5b72f60f…f38df2`. Toggle-additivity report: `docs/httpsms vs dprelay/Modification 6/w2-toggle-additivity.md` (erratum `f2ee336`). **No enrollment performed.** ISSUE-21 **done**. |
| 3 | v4 import + reconciliation | ✅ Done (local baseline) | #27 `84b1ad1`: apply-safety fixes (deterministic timestamp fallback, FK id-space binding, per-bucket error context, idempotent re-runs); local `--apply` on a **copy** of the frozen export — packages=12, apps=11, credit_transactions=3, app_credits=3, integrity ok, 0 FK violations, 11/11 hashed secrets. Report: `docs/Plan/26-V4-IMPORT-RECONCILIATION.md` — 56 source rows → 29 imported / 8 skipped / 4 orphans, **every delta rule-based**; checksums pinned with methods (review erratum `943d580`). `dprelay-prod-2` verified live (200 ok; wrong secret → 401). ISSUE-22 **done**. |
| 4 | M3 tails | ✅ Done | #28 `f6a186f`: OpenAPI at `/docs` + `/docs/json` generated from route definitions, spec committed (`docs/Plan/27-OPENAPI-SPEC.json`) with a drift test; per-phone OTP resend cooldown (`OTP_RESEND_COOLDOWN_SEC`, default 60, `0` disables); webhook exhaustion damping (`WEBHOOK_EXHAUSTION_DAMPING_SEC`, `0` restores legacy semantics). #30 `0321a97`: damping default retuned to **900 s ⇒ ≤4 re-alerts/hour** (the handoff's stated default). Live-verified in production. ISSUE-23 in **review** (fresh review request open). |
| 5 | v5 web dashboard | ✅ Core done — slice remains | #29 `0e0fb5d` + `0f167fb`: clean-room `dashboard/` (React 18 + Vite 5 + Tailwind 3, TS strict; `web/` untouched); JWT register/login/refresh wired to `/v5/auth/*` (live-verified); connect-app layer (app credentials verified before store, dropped on 401); campaigns list/create/detail + pause/resume/cancel-with-refund (full lifecycle exercised against a live server); credits overview + buy flow surfacing the bKash destination from `credits/request`; Cloudflare Pages contract (`_redirects`, `VITE_API_BASE_URL`). Server: `@fastify/cors` fail-closed allow-list (`CORS_ALLOWED_ORIGINS`). **Remaining: AC5–AC7** — contact groups, templates, apps-management (show-once secret, revoke) screens + operator admin view (TrxID approvals, metrics); all server routes already exist. ISSUE-24 in **review**. |
| 6 | Decommission | ⛔ Gated — not started | Preconditions below. |

Also shipped this cycle: Telegram-first alert sink (PR #24 `b32d153`;
`dispatchAlert` prefers `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID`, webhook
fallback, log-only when unconfigured), drill scripts (#22 `ee0f0b5`), and the
cutover checklist itself (#21 `c71783c`).

## Decommission preconditions (Workstream 6 gate)

Workstream 6 starts **only** after **all** of the following — in order:

1. **Owner's explicit written go.** Hard gate; nothing below substitutes.
2. ✅ **Clean reconciliation baseline** (satisfied 2026-09-25):
   `docs/Plan/26-V4-IMPORT-RECONCILIATION.md` — zero unexplained deltas,
   independently review-verified (checksums re-derived from a fresh apply).
3. ⬜ **Fresh cutover-date v4 re-export + production import**, reconciled
   against the same baseline rules (CUTOVER-CHECKLIST §4 T-0). Production
   import is deliberately not executed from the local baseline.
4. ⬜ **Cutover flip complete** (checklist §4 steps 1–5) and the **30-day
   clean soak** (§5) before removing v4 artifacts (`functions/`,
   `firebase.json`, `.firebaserc`, rules files, cloud-function-tests CI job,
   the `web/` v4 zombie; Firebase deps removed from `server/` except
   `firebase-admin` for FCM).

## Owner action items (outside agent gates)

| # | Action | Notes |
|---|---|---|
| 1 | Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` on Render | Then trigger a deploy (env PUTs alone do **not** deploy — use `server/scripts/set-alert-channel.cjs`) and force one real alert (set-stale drill) as delivery proof. Never placeholders. |
| 2 | Set `CORS_ALLOWED_ORIGINS` on Render | The Cloudflare Pages origin; fail-closed (unset = no browser access). Deploy after. |
| 3 | Create the Cloudflare Pages project | Root `dashboard/`, build `npm run build`, output `dist/`. `VITE_API_BASE_URL` defaults to the production URL. |
| 4 | Side-load the APK on the Redmi 9 + enroll | Enrollment happens on the physical phone by the owner; artifact evidence in WS2 row. |
| 5 | Written go for cutover + decommission | Per the checklist and the gate above. |

## Traceability

- Rhizome issues: ISSUE-20–ISSUE-25 (epic ISSUE-14); W6 has no issue by design
  (opens only on the owner's go).
- PRs #17–#30 on `dannyzia/dpRelay`; all merges squash-merged, `Refs:`-linked,
  no AI attribution.
- Key docs: `docs/Plan/26-V4-IMPORT-RECONCILIATION.md`,
  `docs/Plan/27-OPENAPI-SPEC.json`,
  `docs/httpsms vs dprelay/Modification 6/CUTOVER-CHECKLIST.md`,
  `docs/httpsms vs dprelay/Modification 6/w2-toggle-additivity.md`.
- Test-count trajectory across the cycle: 143 → 158 → 169 → 172 → 173.
