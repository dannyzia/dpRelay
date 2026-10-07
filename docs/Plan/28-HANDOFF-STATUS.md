# dP Relay — Handoff Status (2026-09-27)

Tracks execution of the owner handoff queue (`docs/httpsms vs dprelay/
Modification 6/fable5-v2.md`, Workstreams 1–6) and records the decommission
preconditions. Complements `docs/httpsms vs dprelay/Modification 6/
CUTOVER-CHECKLIST.md` (the operational flip procedure). Owner decisions and
secret material are never duplicated here — pointers only.

**Production posture:** `https://dprelay-api-hug8.onrender.com` live at
**5.3.7-alpha.0** (server parity `0321a97` #30; master tip `800d1ed` adds the
docs-only merges #31/#32), `/docs/json` serving the OpenAPI spec (45 paths),
server suite **173/173**, AGPL gate clean, CI 6/6 on recent merges, deploy
guard active. All five implementation workstreams (W1–W5) are review-closed:
Rhizome ISSUE-20 through ISSUE-25 approved and **done** (2026-09-27).

## Workstream record

| WS | Scope | Status | Evidence |
|---|---|---|---|
| 1 | M4 pass 3 deferred routes | ✅ Done | Contact groups/templates CRUD (#17 `d196f23`); admin app plane + migration 009 + rotate/revoke/webhook-update (#18 `50a5f0e`); `POST /v5/apps/revoke`, `GET …/credentials-status`, operator `GET /v5/admin/metrics` + `GET /v5/admin/campaigns` (#25 `d3b3873`); operator kill-switch (#20 `0f20194`). Migration 008 audited: spec already satisfied, no duplicate created. ISSUE-20 **done**. |
| 2 | Android parallel-run APK | ✅ Done | #26 `6656179`: `SmsRateLimiter` confirmed a process-wide singleton shared by both planes (regression-locked by `SmsRateLimiterDualPlaneTest`); `V5_SERVER_URL`/`V5_API_ENABLED=true` BuildConfig verified; JDK 17 build green (lint + 49 unit tests + assembleRelease); APK `app-release.apk` 5,773,851 bytes, sha256 `5b72f60f…f38df2`. Toggle-additivity report: `docs/httpsms vs dprelay/Modification 6/w2-toggle-additivity.md` (erratum `f2ee336`). **No enrollment performed.** ISSUE-21 **done**. |
| 3 | v4 import + reconciliation | ✅ Done (local baseline) | #27 `84b1ad1`: apply-safety fixes (deterministic timestamp fallback, FK id-space binding, per-bucket error context, idempotent re-runs); local `--apply` on a **copy** of the frozen export — packages=12, apps=11, credit_transactions=3, app_credits=3, integrity ok, 0 FK violations, 11/11 hashed secrets. Report: `docs/Plan/26-V4-IMPORT-RECONCILIATION.md` — 56 source rows → 29 imported / 8 skipped / 4 orphans, **every delta rule-based**; checksums pinned with methods (review erratum `943d580`). `dprelay-prod-2` verified live (200 ok; wrong secret → 401). ISSUE-22 **done**. |
| 4 | M3 tails | ✅ Done | #28 `f6a186f`: OpenAPI at `/docs` + `/docs/json` generated from route definitions, spec committed (`docs/Plan/27-OPENAPI-SPEC.json`) with a drift test; per-phone OTP resend cooldown (`OTP_RESEND_COOLDOWN_SEC`, default 60, `0` disables); webhook exhaustion damping (`WEBHOOK_EXHAUSTION_DAMPING_SEC`, `0` restores legacy semantics). #30 `0321a97`: damping default retuned to **900 s ⇒ ≤4 re-alerts/hour** (the handoff's stated default). Live-verified in production. ISSUE-23 **done** (review-approved 2026-09-27; reviewer independently re-ran gates and re-verified the 900 s default-lock test, live /health and /docs/json). |
| 5 | v5 web dashboard | ✅ Done | #29 `0e0fb5d` + `0f167fb`: clean-room `dashboard/` (React 18 + Vite 5 + Tailwind 3, TS strict; `web/` untouched); JWT register/login/refresh wired to `/v5/auth/*` (live-verified); connect-app layer (app credentials verified before store, dropped on 401); campaigns list/create/detail + pause/resume/cancel-with-refund (full lifecycle exercised against a live server); credits overview + buy flow surfacing the bKash destination from `credits/request`; Cloudflare Pages contract (`_redirects`, `VITE_API_BASE_URL`). Server: `@fastify/cors` fail-closed allow-list (`CORS_ALLOWED_ORIGINS`). AC5–AC7 shipped by #32 `800d1ed`: contact groups + templates screens (E.164 dedup counts, 409 duplicate names, member add/remove), apps management (show-once secrets in amber panels, revoke/unrevoke, webhook-secret rotation), operator admin view (session-scoped `OPERATOR_SECRET` verified before store — third credential plane; metrics cards, TrxID approve/reject, kill switch, cross-app oversight). Functional smoke 25/25 incl. revoke → 401 `app_revoked` → unrevoke → restore. ISSUE-24 **done** (review-approved 2026-09-27; reviewer reproduced the build byte-identical, 193.78 kB JS). |
| — | Handoff docs (post-W5) | ✅ Done | #31 `08cb73d`: CUTOVER-CHECKLIST.md refreshed (5.3.7 pin, Telegram-first alert row, T-0 re-verification framing, §7 gaps CLOSED/SUPERSEDED + new CORS gap) and this doc created. ISSUE-25 **done** (review-approved 2026-09-27). Follow-up docs+CI passes pending review: ISSUE-26 (checklist W1–W5 refresh + §1.5 owner deploy steps) and ISSUE-27 (Cloudflare Pages deploy workflow for `dashboard/`). |
| 6 | Decommission | ⛔ Gated — not started | Preconditions below. |

Also shipped this cycle: Telegram-first alert sink (PR #24 `b32d153`;
`dispatchAlert` prefers `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID`, webhook
fallback, log-only when unconfigured), drill scripts (#22 `ee0f0b5`), and the
cutover checklist itself (#21 `c71783c`).

## Decommission preconditions (Workstream 6 gate)

Workstream 6 starts **only** after **all** of the following — in order:

1. ✅ **Owner's explicit written go** (2026-09-28, verbatim in Rhizome
   decision `01M3JYKM3770E7AGTQA8HG7RJ5`): "I am deliberately starting
   Workstream 6 — record my written go in Rhizome, create the W6 issue, and
   walk the decommission preconditions in order before any file deletions."
   Tracked as ISSUE-36.
2. ✅ **Clean reconciliation baseline** (satisfied 2026-09-25):
   `docs/Plan/26-V4-IMPORT-RECONCILIATION.md` — zero unexplained deltas,
   independently review-verified (checksums re-derived from a fresh apply).
3. ⬜ **Fresh cutover-date v4 re-export + production import**, reconciled
   against the same baseline rules (CUTOVER-CHECKLIST §4 T-0). Production
   import is deliberately not executed from the local baseline. Copy-paste
   procedure: **`docs/Plan/31-T0-RUNBOOK.md`** (§0–§6). The read-only
   go/no-go was executed for real on 2026-09-28 — verdict **GO**, zero
   row-count deltas vs the frozen baseline and a byte-identical
   reconciliation report (Rhizome decision `01M3MEBDCB9JC1XJW412JTKP8V`);
   only the production import remains owner-gated at flip time.
4. ⬜ **Cutover flip complete** (checklist §4 steps 1–5) and the **30-day
   clean soak** (§5) before removing v4 artifacts (`functions/`,
   `firebase.json`, `.firebaserc`, rules files, cloud-function-tests CI job,
   the `web/` v4 zombie; Firebase deps removed from `server/` except
   `firebase-admin` for FCM).

> **Deviation (disclosed 2026-09-28):** PR #42 (`f604551`) already removed the
> tracked functions plane (`functions/**`, `firebase.json`, `.firebaserc`,
> rules files, deploy workflows, `cloud-function-tests` CI job) before items
> 3–4 were satisfied. Files remain recoverable from git history; this is
> recorded as a deviation, not a precedent. All remaining v4 artifact removal
> (`web/`, `e2e/`, doc references, untracked `functions/` leftovers) stays
> blocked until items 3 **and** 4 pass. Tracked in ISSUE-36.
>
> **Status walk (2026-09-28):** items 1–2 re-verified live; item 3 go/no-go
> prechecks pass (Firebase project readable metadata-only, frozen baseline
> intact) and the §0–§6 sequence (`31-T0-RUNBOOK.md`) was executed for real
> the same day — verdict **GO**, zero unexplained deltas — while the
> re-export + production import remain owner-gated at flip time; item 4
> follows the cutover. Live tracker and audit trail: Rhizome **ISSUE-36**.
> Related: ISSUE-37 (runbook execution) — the **webhook-fallback alert path is
> proven end-to-end** (2026-09-28) and was re-verified and hash-anchored on
> 2026-10-03: 16/16 receipt lines parse 1:1, the temporary-override **and its
> revert** are both visible in delivered payloads (`threshold_sec` 60 at
> 07:44:45 and 07:45:01, then 900 at 07:47:59 and twice at 07:50:01, same three
> device ids throughout), and auth is enforced three ways (wrong secret,
> absent auth, tampered body all rejected). Hashes are recorded in
> `29-OWNER-CHECKLIST.md` §3 and in ISSUE-37.
>
> The **Telegram primary path (§1.4) is closed by owner attestation as of
> 2026-10-03 — agent-unverified.** The owner observed the alert land in the ops
> group and accepted the proof on that basis; the agent could not corroborate it.
> Production `dprelay-api` (`srv-dal3bae7bikc73e7k7pg`) held **16 env keys with no
> `TELEGRAM_*`** on every check that day, the live deploy was unchanged since
> 2026-09-29, and a 3000-line log sweep showed 30 `watchdog_alert` emissions, all
> `threshold=900`, with zero `threshold=60`. Production was therefore still
> log-only and the observed alert is attributable to a local `sendMessage` probe.
> **Residual risk:** if the sink is in fact unset, no incident will page anyone.
> One env read settles it — 18 keys with both `TELEGRAM_*` corroborates the
> attestation, 16 keys means §1.4 should be reopened. Service id
> `srv-dal3bae7bikc73e7k7pg`.
>
> **Sharpened 2026-10-03 — §1.4 is two gates, not one.** "Closed by owner
> attestation" above applies to **gate A only (credential + membership)**: valid
> token, bot in the ops group, chat id resolves, probe delivered. **Gate B
> (production delivery) is still OPEN**, and the two are independent — valid
> creds that were never deployed is an ordinary state, and a single combined box
> could only ever report the weaker half. Gate A is owner-verified and
> agent-uncorroborated: those credentials have never existed on this machine and
> `staging/` holds no Telegram receipt (its one line is the *webhook* self-test).
> Gate A says nothing about production, which is still log-only. The
> attestation comment on ISSUE-37 mistyped the service id as `...k7kg` in its
> disconfirming-check line; corrected in comment `01M40N1P7CPKJRZMAJK28TQW9F`.
> A typo there is not cosmetic — `...k7kg` does not exist, so a GET returns
> empty rather than a key count, and "no keys" reads as the attestation failing.
>
> **Tooling defect behind the repeated no-op attempts: FIXED.** ISSUE-37 named
> `DRY_RUN=1` as the strongest hypothesis for why the documented one-command path
> never wrote to Render — the script skipped the write, printed a reassuring
> final line, and exited 0, so a "real" run looked successful while doing
> nothing. `set-alert-channel.cjs` now treats `DRY_RUN` as a hazard rather than a
> rehearsal switch: any non-empty value makes it **refuse to run** — exit 2, loud
> stderr banner naming the skipped Render write, before argument parsing and
> before any network call, so no mode is reachable. Only an explicitly unset
> value permits a run (`DRY_RUN= node …`, `unset DRY_RUN`, or a fresh shell).
> Fails closed: a whitespace-only value blocks too. Regression tests in
> `server/test/set-alert-channel.test.ts` (hermetic — local mocks for both APIs).
> Uncommitted on `docs-load-repro` at the time of writing; `master` untouched.
>
> Also still open on ISSUE-37: the §1.5(c) Pages publish is gated on a
> `CLOUDFLARE_API_TOKEN` that Cloudflare rejects — `6003` "Invalid request
> headers", inner `6111` "Invalid format for Authorization header". The
> workflow defect is fixed and proven on `docs-load-repro`; `master` is
> untouched.
>
> **Corrected 2026-10-03: `6003`/`6111` is NOT a malformed-value signal.** The
> earlier note here read that error as "a malformed value". Probing the live
> endpoint (`/client/v4/user/tokens/verify`) shows `6003`/`6111` is Cloudflare's
> generic invalid-token response, identical for every rejected form:
>
> | header sent | HTTP | code |
> |---|---|---|
> | none | 400 | `1001` "Missing Authorization header" |
> | invalid token, 40 chars (real token length) | 400 | `6003` / inner `6111` |
> | invalid token, 31 chars | 400 | `6003` / inner `6111` |
> | invalid token + trailing space | 400 | `6003` / inner `6111` |
> | invalid token wrapped in quotes | 400 | `6003` / inner `6111` |
>
> The previously documented mapping — "a wrong token gives `9109`, an absent
> header gives `9106`" — is wrong on both counts; observed values are `6003` and
> `1001`. Expired, revoked, wrong-scope and wrong-account remain equally
> consistent with the evidence, and this run cannot separate them.
>
> Two traps worth knowing before re-diagnosing:
> - `.kilo/kilo.jsonc` holds **no** Cloudflare credential at all (only
>   `mcp.cloudflare.{type,url,enabled}`). A local probe therefore sends
>   `Authorization: Bearer ` with an empty value and receives the *same* `6003`,
>   which reads like proof about the real secret and proves nothing.
> - A newline inside the token cannot reach Cloudflare at all: Node rejects the
>   header client-side (`ERR_INVALID_CHAR`), so that contamination mode surfaces
>   as a local error, never as a Cloudflare error code.
>
> The secret is **not** missing: CI reports `HAS_CLOUDFLARE: true` and the
> preflight's empty-value branch never fires. The preflight verifies the token
> before testing account reachability, so the account check is never reached and
> the "valid token, wrong scope" case stays invisible. Latest failing run
> **37100586782** (2026-10-03T05:40:39Z, `workflow_dispatch`); `master` last
> attempted **36982301978** (2026-10-02T08:07:49Z), also failed.

## Owner action items (outside agent gates)

> Execution-ordered walkthrough with verifications: **`docs/Plan/29-OWNER-CHECKLIST.md`** (ISSUE-31) — the items below are the record; the checklist is the procedure.

| # | Action | Notes |
|---|---|---|
| 1 | Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` on Render | Then trigger a deploy (env PUTs alone do **not** deploy — use `server/scripts/set-alert-channel.cjs`) and force one real alert (set-stale drill) as delivery proof. Never placeholders. Steps + proof: CUTOVER-CHECKLIST §1.5(a). |
| 2 | Set `CORS_ALLOWED_ORIGINS` on Render | **DONE 2026-10-03** — set to `https://dprelay-dashboard.pages.dev` and deployed. Live-verified: preflight `OPTIONS /health` with that Origin → 204 with `access-control-allow-origin` echoing it, while an unlisted origin (`https://evil.example`) gets 204 with **no** allow-origin header. Fail-closed by design. Remaining gap is not CORS: the origin is NXDOMAIN until the first successful Pages deploy. Steps + preflight proof: CUTOVER-CHECKLIST §1.5(b). |
| 3 | Set the 3 GitHub Actions secrets for the Pages deploy | All three secrets exist. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT` are set; `CLOUDFLARE_API_TOKEN` is set but **rejected by Cloudflare** (`6003`/`6111`), so no dashboard has ever published — see the Cloudflare root-cause note above for why that code does not mean "malformed". **Action: mint a fresh token with Account · Cloudflare Pages · Edit and replace the secret.** Then master pushes touching `dashboard/` auto-build and publish via `.github/workflows/dashboard-pages-deploy.yml` (wrangler direct-upload; the first run creates the Pages project; production deployments mapped to main). `VITE_API_BASE_URL` defaults to the production URL. Steps: CUTOVER-CHECKLIST §1.5(c). |
| 4 | Side-load the APK on the Redmi 9 + enroll | Enrollment happens on the physical phone by the owner; artifact evidence in WS2 row. |
| 5 | Written go for cutover + decommission | Per the checklist and the gate above. |

## Traceability

- Rhizome issues: ISSUE-20 through ISSUE-35 **done** (epic ISSUE-14);
  ISSUE-36 tracks Workstream 6 (created on the owner's written go; gated on
  items 3–4 above); ISSUE-37 tracks runbook execution steps 2–5 (owner-gated).
- PRs #17–#45 on `dannyzia/dpRelay`; all merges squash-merged, `Refs:`-linked,
  no AI attribution.
- Key docs: `docs/Plan/26-V4-IMPORT-RECONCILIATION.md`,
  `docs/Plan/27-OPENAPI-SPEC.json`,
  `docs/httpsms vs dprelay/Modification 6/CUTOVER-CHECKLIST.md`,
  `docs/httpsms vs dprelay/Modification 6/w2-toggle-additivity.md`.
- Test-count trajectory across the cycle: 143 → 158 → 169 → 172 → 173.
