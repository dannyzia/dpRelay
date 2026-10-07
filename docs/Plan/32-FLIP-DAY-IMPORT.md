# Flip-Day Production Import Addendum (§4 T-0 → step 1 mechanics)

| | |
|---|---|
| **Purpose** | Owner-attended procedure to load the v4 data (packages / apps / credit transactions / credits) into the production v5 database at flip time — the `--apply` step `31-T0-RUNBOOK.md` rehearses but deliberately does not execute against production. |
| **Refs** | ISSUE-36 (W6 precondition 3), ISSUE-22 (mechanics), `31-T0-RUNBOOK.md` (export + GO gate), `26-V4-IMPORT-RECONCILIATION.md` (baseline rules), CUTOVER-CHECKLIST §6 (rollback posture) |
| **§7 push proof** | `fcm_wake_failed` alerting makes a broken push credential *visible after* the fact; it does not make it *proven before* you accept the flip. Any change to `FCM_SERVICE_ACCOUNT_JSON` — rotation, re-upload, IAM edit, or the flip's own restart — is closed by `server/scripts/fcm-wake-probe.cjs` returning `ACCEPTED` (exit 0) **and** the gateway device showing `FCM message received` with an advanced `lastPing`. A stored key plus a green `/health` is not that. §7 has the verdict table, the token handling rules, and the read-only token query. |
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
- **Alert-sink health — check this explicitly.** A restart re-points config, so
  flip day is precisely when a sink can break with no visible symptom: alert
  delivery swallows failures by contract, and a dead `ALERT_WEBHOOK_URL` is
  otherwise indistinguishable from a healthy one. Since `feat(server): surface a
  repeatedly failing alert sink`, the service emits two greppable events:

  | Event | Level | Meaning |
  |---|---|---|
  | `alert_sink_degraded` | `error` | one sink has failed `ALERT_SINK_FAILURE_THRESHOLD` consecutive times (default 3 ≈ 15 min at the 5-min watchdog cadence). Re-emits on each further multiple of the threshold |
  | `alert_sink_recovered` | `info` | first success after a degradation; carries `consecutiveFailures` and `degradedSince` |

  Payload fields on `alert_sink_degraded`: `sink` (`telegram` or `webhook`),
  `consecutiveFailures`, `threshold`, `degradedSince`, `lastError`. The two sinks
  are counted independently, so `sink: "telegram"` with no `sink: "webhook"`
  means the fallback is still viable.

  **Acceptance:** post-flip, zero `alert_sink_degraded` in the log window, and
  at least one real alert (the ISSUE-38 baseline ticks supply this) with **no**
  `telegram alert failed` line. A `alert_sink_degraded` at flip time is a
  **stop-and-investigate**, not a warning to note — see §8, because a silently
  dead sink turns every subsequent incident into silence.

  ```bash
  # read-only sweep of the flip window (adjust the window to the flip date)
  node staging/render-log-sweep.cjs | grep -E "alert_sink_degraded|alert_sink_recovered|telegram alert failed"
  # expect: no alert_sink_degraded, no "telegram alert failed"
  ```

- **FCM push — prove it, do not infer it.** This check is not flip-specific and
  it is **mandatory after every credential change**, not just at flip. A service
  account can be rotated, re-uploaded, and stored correctly, `/health` can be
  200, and the key can still be **revoked at the source or missing the FCM
  sender role**. The FCM wake is best-effort by contract — OTP delivery falls
  back to the phone's reconcile fetch — so every one of those failures presents
  as *nothing at all*: OTPs still succeed, phones still wake, and the only
  symptom is push quietly getting less reliable. `rotate-fcm-key.cjs verify`
  cannot catch this; it proves the key was **stored**, not that it can push.
  Send one real message and read the verdict.

  ```bash
  # after ANY FCM_SERVICE_ACCOUNT_JSON change — rotation, re-upload, IAM edit,
  # or the flip itself (the import restarts the service and re-points config)
  node server/scripts/fcm-wake-probe.cjs --token-file /path/to/fcm-token.txt
  # or, to test a candidate BEFORE it is written to Render:
  node server/scripts/fcm-wake-probe.cjs --key-file ./new-sa.json --token-file /path/to/fcm-token.txt
  ```

  The Render credential it uses comes from `server/scripts/render-key.cjs`
  (`RENDER_API_KEY` → `$RENDER_API_KEY_FILE` → the OS keyring), so it works
  wherever the other ops scripts do. On the owner's own machine it reads the
  keyring; on anything without a session bus, export `RENDER_API_KEY` first.

  | Exit | Verdict | Meaning for the flip |
  |---|---|---|
  | 0 | `ACCEPTED` | FCM accepted a real send. Credential is healthy. |
  | 1 | `KEY UNHEALTHY` | **Stop.** Credential cannot authenticate or FCM rejected it. Fix before accepting the flip. |
  | 2 | no token supplied | Probe refused to guess — not a verdict. Supply the token and re-run. |
  | 3 | `TOKEN STALE` / `TOKEN BAD` | **The key is healthy** — FCM accepted the credential and refused the target. This is a device problem, not a credential one. |
  | 4 | `QUOTA` | Key healthy, FCM rate-limiting. Re-run later; not a key fault. |
  | 5 | `UNEXPECTED` | Read the body it prints before concluding anything. |

  Note the asymmetry that matters on flip day: **exit 1 and exit 3 both mean
  something broke, but only exit 1 is a credential fault.** Rotating the key
  because of a `TOKEN STALE` would replace a healthy credential with an
  unverified one and hide the real problem.

  `--dry-run` mints the token and runs the empty-message auth probe only — it
  proves the credential authenticates but contacts no device, so it is the
  right check for “can this key push at all”, **not** the one that satisfies
  this item. Do not record a dry run as the push proof.

  The token is the device's own, self-registered via `POST /v5/device/fcm-token`;
  there is deliberately no copy of it in the repo. Use the most recently seen
  non-revoked device. Pass it via `--token-file`, **not** bare argv — a bare
  token lands in shell history and in `ps` for every user on the box.

  ```bash
  # read-only: newest non-revoked device token, written straight to a 0600 file
  # so it never reaches the terminal, shell history, or a paste-able buffer.
  # Uses better-sqlite3 like §5, not the sqlite3 CLI — no new dependency, and
  # `length(fcm_token) > 0` sidesteps the nested-quote trap in `!= ''`.
  cat > /tmp/fcm-token.cjs <<'EOF'
  const D = require(require.resolve("better-sqlite3", { paths: [process.cwd()] }));
  const row = new D(process.argv[2]).prepare(
    "SELECT fcm_token FROM devices WHERE revoked_at IS NULL " +
      "AND fcm_token IS NOT NULL AND length(fcm_token) > 0 " +
      "ORDER BY last_seen_at DESC LIMIT 1",
  ).get();
  require("fs").writeFileSync(process.argv[3], row ? row.fcm_token + "\n" : "");
  require("fs").chmodSync(process.argv[3], 0o600);
  console.log(row ? "token written (value not printed)" : "no device has registered a token");
  EOF
  mv /tmp/fcm-token.cjs ./fcm-token-probe.cjs   # .cjs: the repo root has no "type",
                                                # and .mjs would force ESM where
                                                # require() does not exist
  cd server && node ../fcm-token-probe.cjs "../staging/flip-restore-$(date +%F)/dprelay.db" /tmp/fcm-token.txt
  cd .. && rm -f fcm-token-probe.cjs

  node server/scripts/fcm-wake-probe.cjs --token-file /tmp/fcm-token.txt
  shred -u /tmp/fcm-token.txt
  ```

  If the helper prints `no device has registered a token`, the probe still runs
  but stops at exit 2 — **note that exit 2 is only reachable once the credential
  has already passed the auth probe.** The probe checks FCM's authorisation
  *before* it looks at the token, so while the credential is broken you get exit
  1 (`KEY UNHEALTHY`) and the missing token is not even reported. Fix the
  credential first, then expect exit 2 until a gateway device self-registers
  (its reconcile heartbeat registers it). Do not substitute a token from
  anywhere else.

  **Corroborate device-side — a 200 alone is half the proof.** The send returns
  accepted by FCM, not delivered to the phone. On the gateway device, logcat
  shows `FCM message received` and `/health/{androidId}.lastPing` in Firebase
  RTDB advances. Both moving is end-to-end proof; **either one alone means look
  past the key** — the credential is fine and the problem is between FCM and the
  app. A `200 + message id` with an unmoved `lastPing` is not a green flip.

  Since `fcm_wake_failed` alerting, a credential that breaks in production now
  raises an operator alert instead of failing silently — but that alert is a
  tripwire for *after* the flip, not a substitute for proving push before you
  accept it.

  #### `KEY UNHEALTHY` triage (403) — do this first, it is not a key rotation

  As of 2026-10-04 the live credential is in exactly this state, so expect it on
  the first run rather than treating it as a surprise. The probe reports:

  ```
  auth       : OK (OAuth token minted)
  FCM        : KEY UNHEALTHY — FCM rejected the credential (HTTP 403).
  ```

  `auth OK` + `403` is the whole diagnosis: **the key is valid and not revoked**,
  so do **not** rotate it. The permission is missing. FCM returns:

  ```
  status : PERMISSION_DENIED   reason : IAM_PERMISSION_DENIED
  permission : cloudmessaging.messages.create
  resource   : projects/authenticator-15fb7
  ```

  On this project the cause is **the FCM API itself is not enabled**, not only
  the role. Every other Firebase API is on (`firebase`, `firebasedatabase`,
  `firebaseremoteconfig`, `firebaseinstallations`, …) but
  `cloudmessaging.googleapis.com` is absent from the enabled list — which is
  also why the error says "or it may not exist". Remediation, in order:

  ```bash
  gcloud services enable cloudmessaging.googleapis.com --project=authenticator-15fb7
  # then grant the sender role. It is NOT grantable via
  #   gcloud projects add-iam-policy-binding --role=roles/firebasemessaging.sender
  # (rejected: "Role … is not supported for this resource"). Use the Firebase
  # console → Project settings → Service accounts, or:
  #   firebase projects:add-iam-policy-binding authenticator-15fb7 \
  #     --member serviceAccount:authenticator-15fb7@appspot.gserviceaccount.com \
  #     --role roles/firebasemessaging.sender
  ```

  Enabling the API is a production change with billing implications — treat it
  as an owner decision, not a flip-day step. Until it is done, **push is broken
  and OTP delivery is carried entirely by the phone's reconcile fetch.** The
  flip itself is unaffected: that fallback is exactly why `wakeGateway` is
  best-effort.

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
- **Alert sink degraded at flip time** (see §7): this is **not** a data problem,
  so do not roll the DB back for it. Read `sink` and `lastError` from the
  `alert_sink_degraded` line first — a wrong `TELEGRAM_CHAT_ID`, a stale bot
  token, or a bad `ALERT_WEBHOOK_URL` all present identically. Fix the env var
  and redeploy; there is no data to restore, and rolling back would discard real
  post-flip traffic for a config-only fault. If the sink was already degraded
  before the flip, note it as pre-existing baseline (like the ISSUE-38 device
  rows) rather than attributing it to the import. Counters are process-local, so
  a redeploy resets them — a clean counter after redeploy is expected, not proof
  the sink is healthy. Confirm with one real alert delivery instead.
- **v4 is never a fallback** (§6 "truth first"): rollback lands you on a
  pre-import **v5**, not on v4.

## 9 · Evidence to record (ISSUE-36, §4 step 1)

Append to the W6 tracker: restore timestamp + replica generation ID, apply
transcript (`tee staging/flip-apply-<date>.txt`), verifier output, upload
completion, resume time, live-service spot-checks. That closes the §4 step-1
row ("balance > 0 via /v5/billing/credits" is then proven by §4 step 2/3).
