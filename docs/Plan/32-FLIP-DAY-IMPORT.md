# Flip-Day Production Import Addendum (§4 T-0 → step 1 mechanics)

| | |
|---|---|
| **Purpose** | Owner-attended procedure to load the v4 data (packages / apps / credit transactions / credits) into the production v5 database at flip time — the `--apply` step `31-T0-RUNBOOK.md` rehearses but deliberately does not execute against production. |
| **Refs** | ISSUE-36 (W6 precondition 3), ISSUE-22 (mechanics), `31-T0-RUNBOOK.md` (export + GO gate), `26-V4-IMPORT-RECONCILIATION.md` (baseline rules), CUTOVER-CHECKLIST §6 (rollback posture) |
| **Rehearsed** | 2026-09-28/29: full mechanics proven on a throwaway DB — fresh `--apply` exit 0, independent SQL counts match the baseline (12/11/3/3, 1 revoked app, 2 TrxIDs attached, 0 duplicates, FK 0), idempotent re-run inserts nothing (Rhizome ISSUE-36 evidence). Production differs **only** in: DB sourced from the Litestream replica, operator secret material in your hands, and the stop-the-world step. |

## 0 · Why this shape (architecture constraints, read once)

- **Render free tier has no SSH.** "Run `--apply` against Render's DB" is not
  executable in place — the sanctioned production DB access is **Litestream**
  (CUTOVER-CHECKLIST §7.1: "Production DB access = Litestream download").
- **The Render disk is ephemeral.** Every boot runs
  `litestream restore -if-db-not-exists ./data/dprelay.db` (`start-server.mjs`)
  and then streams WAL back to R2 under `replicate -exec`. The DB of record is
  **the R2 replica generation**, not the disk.
- Consequence: the import is **restore → apply locally → push a new
  Litestream generation → let Render boot into it**. Render → **Suspend
  Service** is the stop-the-world lever (§6) that makes this safe.

## 1 · Pre-flight (all must hold before touching anything)

```bash
export PATH="$HOME/.nvm/versions/node/v20.9.0/bin:$PATH"
cd "/home/zia/Documents/My Projects/Authenticator"

git fetch origin && git status --porcelain | grep -v '^??' || true
# work from master tip; server/build artifacts must come from this commit

curl -s https://dprelay-api-hug8.onrender.com/health
# expect {"status":"healthy",...,"db":"ok"}

node staging/render-log-sweep.cjs   # or glance at Render Logs — no incident in progress
```

- §4 T-0 already done today (9/9 export, verify OK, GO recorded), and
  `31-T0-RUNBOOK.md` §3's fresh `--apply` rehearsal passed on the same export.
- R2 credentials available locally (the same `R2_*` values already set on
  Render — they live only in your secret store, never in git/chat).
- **Nobody is mid-payment.** Announce a short maintenance window; the v4 plane
  is already dark, and v5 has live OTP/billing traffic only after §4 steps 1–3.

## 2 · Stop the world (Render → Suspend Service)

Dashboard → `dprelay-api-hug8` → **Suspend Service**. This is §6's hard stop:
no API traffic, no WAL writes, no cron ticks. Verify: `/health` stops
responding (connection refused / 5xx from the proxy). The service stays
suspended through step 5 — Suspended services cost nothing on the free tier.

## 3 · Restore the production DB locally (read-only against R2)

```bash
cd server
node scripts/download-litestream.mjs          # ensures bin/litestream 0.3.12 present
./bin/litestream restore -h                   # CONFIRM the -o / replica-URL flags on THIS binary first
mkdir -p ../staging/flip-restore-$(date +%F)  # throwaway restore dir, gitignored
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
  ./bin/litestream restore -o "../staging/flip-restore-$(date +%F)/dprelay.db" \
  s3://dprelay-litestream/dprelay.db
# values pasted at your terminal only; the restore is a READ from R2
```

(Bucket/object names follow `server/litestream.yml`; if the replica path
differs, copy the `path`/`bucket` from that file — do not guess. The
`-o <file> s3://<bucket>/<path>` restore form is the standard Litestream CLI
shape, but confirm against the bundled binary's `-h` output before relying on
it — the repo has only ever exercised restore via `start-server.mjs`.)

Baseline the restored DB before any change:

```bash
node ../staging/verify-apply-rehearsal.cjs ../staging/flip-restore-$(date +%F)/dprelay.db
# expect the PRE-import state. On today's prod that is packages=0 apps=0
# credit_transactions=0 app_credits=0 (plus whatever §2 provisioning created —
# if /v5/apps/register already ran, apps>0; the import is DO NOTHING on
# conflicts, but reconcile any pre-existing app_id against the v4 set FIRST).
node -e "const D=require(require.resolve('better-sqlite3',{paths:['.']}));const db=new D('../staging/flip-restore-$(date +%F)/dprelay.db');console.log(db.prepare('PRAGMA integrity_check').get(), db.prepare('PRAGMA foreign_key_check').all().length, 'FK violations')"
# expect: integrity ok, 0 violations. ABORT on anything else — a corrupt
# replica is a §6 data-integrity incident, not a flip problem.
```

## 4 · Apply the v4 import (the rehearsed command, production DB)

```bash
npx tsx src/scripts/migrate-v4.ts --apply \
  --db "../staging/flip-restore-$(date +%F)/dprelay.db" \
  --export "../staging/v4-export-cutover-$(date +%F)"
```

Expect, exactly (the dry-run/apply equivalence is rehearsed):

```
TOTAL: rows=56 imported=29 skipped=8 orphans=4
deterministic checks: packages=12 apps=11 transactions=3 creditRows=3
trx_id uniqueness: 2 attached, 0 duplicates
APPLIED. 11 new app secret(s) written to <export>/../v4-import-app-secrets.json (0600)
```

- **The 11 app secrets are return-once** — move that 0600 file into your
  secret store immediately; it is how client apps re-authenticate post-flip.
- If apply fails mid-way: the script aborts inside one transaction and rolls
  back; delete the restored file, re-restore from R2, and retry once. A second
  failure = no-go (§4 abort column).
- Interrupted session? The apply is idempotent (`ON CONFLICT DO NOTHING`);
  re-running against the same restored DB is safe and inserts nothing new —
  proven in rehearsal.

## 5 · Verify the imported DB (independent of the script's own report)

```bash
node ../staging/verify-apply-rehearsal.cjs "../staging/flip-restore-$(date +%F)/dprelay.db"
# expect packages=12 apps=11 credit_transactions=3 app_credits=3, FK 0, integrity ok
```

Post-import queries worth eyeballing (read-only):

```sql
SELECT is_active, COUNT(*) FROM packages GROUP BY is_active;      -- 9 active / 3 inactive
SELECT CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END, COUNT(*) FROM apps GROUP BY 1;  -- 10 / 1
SELECT status, COUNT(*) FROM credit_transactions GROUP BY status; -- 1 approved / 2 rejected
SELECT COUNT(*) FROM app_credits WHERE otp_sms_remaining > 0 OR bulk_sms_remaining > 0;  -- 3
```

## 6 · Ship the new generation back to R2, then resume

Litestream generations are cut by the writer. The clean path is to let Render's
own supervision do it: put the imported DB where the boot finds it **before**
restore, then boot once into replicate.

1. In `server/litestream.yml`, note the replica path/bucket used in step 3.
2. Upload the imported DB as the new generation base. Either:
   - **Local `litestream replicate` of a static DB** (spot-check only — do not
     leave it running), or
   - the deliberate, reviewed path: temporarily `LITESTREAM_ENABLED=false` is
     NOT acceptable for the real service; instead use
     `litestream replicate -config litestream.yml` locally **once** against the
     imported DB with the SAME config, watch it open a new generation and push
     the initial snapshot + WAL, then Ctrl-C. R2 now holds the imported state.
     [UNVERIFIED mechanically — rehearse once against a scratch bucket before
     flip day; and confirm in the R2 bucket that a NEW generation directory
     appeared before resuming the service, so Render cannot boot into the
     old state.]
3. Render → **Resume Service**. Boot flow: restore pulls the new generation
   (`-if-db-not-exists` on the empty ephemeral disk), replicate continues from
   it, migrations 001–009 are no-ops (schema already applied).
4. Confirm lineage: the live service now reports the imported rows:

```bash
curl -s "$BASE/v5/billing/packages"        # 9 active v4 packages visible
curl -s "$BASE/health"                     # healthy, db ok
```

## 7 · Post-import verification against the LIVE service

- `curl -s "$BASE/v5/billing/packages" | jq length` → matches the active
  package count.
- Operator plane: `/v5/admin/apps` (Bearer `OPERATOR_SECRET`) → the 11 imported
  apps appear, 1 revoked.
- Credits: `/v5/billing/credits` with a re-provisioned app's credentials →
  balance matches `app_credits`.
- First real OTP send → verify (§3 smoke) lands **after** the import; watch the
  Telegram alert channel stay quiet about anything NEW (the 3 known
  never-heartbeated device rows per ISSUE-38 are expected baseline noise).

## 8 · Rollback notes (data-level, §6-compatible)

- **Golden rule: the pristine restore from step 3 is the rollback artifact.**
  Do not delete `staging/flip-restore-<date>/` until §5's 30-day soak is
  green. It is the byte-exact pre-import DB.
- **Bad import detected before any real traffic:** Suspend again, re-restore
  the pristine DB, re-upload it as the newest generation (same mechanics as
  step 6), Resume. Render boots back into pre-import state. Minutes.
- **Bad import detected after some traffic:** the post-import WAL in R2 is
  append-only by generation — Litestream can restore to a timestamp
  (`litestream restore -timestamp`) between the import and the incident. Use
  PITR to just before the corruption point rather than nuking real traffic.
- **App-level rollback** (§6 table) still applies on top: revoke a misbehaving
  imported app via the operator plane; Render → Rollback reverts *code*, not
  data — only a generation re-push reverts *data*.
- **v4 is never a fallback** (§6 "truth first"): rollback lands you on a
  pre-import **v5**, not on v4.

## 9 · Evidence to record (ISSUE-36, §4 step 1)

Append to the W6 tracker: restore timestamp + replica generation ID, apply
transcript (`tee staging/flip-apply-<date>.txt`), verifier output, upload
completion, resume time, live-service spot-checks. That closes the §4 step-1
row ("balance > 0 via /v5/billing/credits" is then proven by §4 step 2/3).
