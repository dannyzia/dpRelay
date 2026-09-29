# T-0 Re-Export & Dry-Run Reconciliation Runbook (ISSUE-36 gate item 3)

| | |
|---|---|
| **Date drafted** | 2026-09-28 (pre-scheduled; execute when the owner fixes the cutover date) |
| **Refs** | ISSUE-36 (W6), CUTOVER-CHECKLIST §4 T-0 row, `26-V4-IMPORT-RECONCILIATION.md` (baseline: 56 → 29/8/4, checksums pinned), ISSUE-22 (mechanics proven) |
| **Tooling** | `server/scripts/export-v4-cutover.cjs` (committed), `server/src/scripts/migrate-v4.ts` (committed, review-verified) |
| **Rehearsed** | 2026-09-28: full sequence executed end-to-end against live Firebase (read-only) — 9/9 sources exported, `--verify` OK, **all 56 rows structurally identical to the baseline** (RTDB hashes byte-equal; Firestore doc-for-doc equal after normalization; `TOTAL 56 → 29/8/4`, `packages=12 apps=11 transactions=3 creditRows=3`, 2 attached TrxIDs / 0 duplicates). Evidence: `staging/t0-reconcile-2026-09-28.txt` (gitignored). gcloud user token required — the functions-era service account has no IAM roles (RTDB 401); at T-0 run §1 option (b), not (a). |
| **Scope** | **Export + dry-run reconciliation only.** No production writes. This closes W6-P3's *precondition evidence*; the production `--apply` and the flip itself are later gated steps (§4 steps 1–5 of the checklist) |

**What "pass" means:** a fresh cutover-date export of the same 9 sources
reconciles against the frozen baseline's *rules* — per-source row counts
accounted for, TOTAL lands on the rule-based transform of the fresh counts,
zero NEW unexplained deltas. The frozen baseline
(`staging/v4-export-final-2026-09-19/`) is read-only forever.

---

## 0 · Pre-flight (all four, in order — abort on any failure)

```bash
cd "/home/zia/Documents/My Projects/Authenticator"
export PATH="$HOME/.nvm/versions/node/v20.9.0/bin:$PATH"

# 0.1 On master, clean, synced
git fetch origin && git status --porcelain | grep -v '^??' && echo "ABORT: dirty tree" || true
[ "$(git log --oneline -1 | cut -d' ' -f1)" = "$(git rev-parse origin/master | cut -c1-7)" ] || echo "WARN: local != origin — reconcile before proceeding"

# 0.2 v5 production healthy (nothing in this runbook touches it, but the gate
#     section below is evaluated against a healthy plane)
curl -s https://dprelay-api-hug8.onrender.com/health
# expect: {"status":"healthy",...,"db":"ok"}

# 0.3 Frozen baseline intact (mtimes must predate today; any newer mtime = ABORT)
ls -la staging/v4-export-final-2026-09-19/ staging/v4-export-final-2026-09-19/*/ | head -20

# 0.4 Credentials present (choose ONE):
#   (a) service account JSON (0600, gitignored leftover):
ls -la functions/authenticator-15fb7-36cfda9edf3b.json
#   (b) or gcloud available for a user token:
command -v gcloud && gcloud auth print-access-token >/dev/null 2>&1 && echo "gcloud token OK"
```

## 1 · Mint the token (0600, never printed)

```bash
umask 077
# Option (a) — let the exporter mint from the service account (no gcloud needed):
export FIREBASE_SERVICE_ACCOUNT_JSON="functions/authenticator-15fb7-36cfda9edf3b.json"

# Option (b) — gcloud user token (expires in ~1 h; re-run §1 if §2 crosses it):
# export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
```

## 2 · Export (9 sources → manifest; aborts on empty/unreadable source)

```bash
node server/scripts/export-v4-cutover.cjs
# writes staging/v4-export-cutover-<today>/ with rtdb/ + firestore/ + manifest.json
# printed output: per-source "rows=N sha256=…" ONLY — contents never displayed
```

Then verify the export against its own manifest (catches partial writes):

```bash
node server/scripts/export-v4-cutover.cjs --verify
# expect: 9 × "MATCH …" then "VERIFY OK"
```

## 3 · Manifest gate (compare against the 2026-09-19 shape)

```bash
node -e '
const a = require("./staging/v4-export-final-2026-09-19/manifest.json");
const b = require(`./staging/v4-export-cutover-${new Date().toISOString().slice(0,10)}/manifest.json`);
const A = Object.fromEntries(a.sources.map(s => [s.source, s.rows]));
const B = Object.fromEntries(b.sources.map(s => [s.source, s.rows]));
console.log("source".padEnd(28), "baseline", "cutover", "delta");
let changes = 0;
for (const k of Object.keys(A)) {
  const d = B[k] - A[k];
  if (d !== 0) changes++;
  console.log(k.padEnd(28), String(A[k]).padStart(8), String(B[k] ?? "MISSING").padStart(7), (d > 0 ? "+" : "") + d);
}
console.log(`\nsources: ${b.sources.length}/9 | row-count deltas: ${changes}`);
console.log("expected non-zero deltas (v4 served until 2026-09-23): stats/health/registered_apps may grow; packages/transactions/app_credits may change; contactGroups/messageTemplates may grow");
'
```

Row-count deltas are **expected** — v4 served real traffic until 2026-09-23.
What matters is that every delta is explainable in §5. The hashes will differ
(new data); do not compare them to the baseline's.

## 4 · Dry-run reconciliation (reads only — writes nothing)

```bash
cd server
npx tsx src/scripts/migrate-v4.ts --export "../staging/v4-export-cutover-$(date +%F)"
cd ..
```

The report prints per-source `rows / imported / skipped / orphans` and ends
with `TOTAL:` + `DRY RUN — nothing written.`

## 5 · Reconcile against the baseline rules (26-V4-IMPORT-RECONCILIATION.md)

Map each fresh number through the baseline's delta rules:

| Source | Baseline rule | Fresh-run expectation |
|---|---|---|
| packages | 20 docs → 12 codes (slugify collapse, ON CONFLICT) | fresh docs ≥ 12; distinct codes after collapse = 12 **unless** new codes were added late in v4 — each extra code must be a real v4 package, named in the delta note |
| registered_apps → apps | 11 → 11, 1:1, inactive → revoked | fresh apps = baseline + any post-baseline registrations; every extra app explainable |
| transactions | 5 → 3 (1 unmapped-package orphan, 1 duplicate-TrxID orphan kept-earliest) | fresh count ≥ 3; every new row either maps cleanly or lands in a **named** orphan class |
| app_credits | 3 → 3 (latest snapshot per app) | count = apps count (one row per app) |
| stats / config / health | 11 / 2 / 2 → 0 (by design, not imported) | any fresh counts, imported stays 0 |
| contactGroups / messageTemplates | 1 / 1 → 0 (uid-keyed orphans by design) | any fresh counts, imported stays 0 |

**Pass condition:** `TOTAL: rows=R imported=I skipped=S orphans=O` where every
difference from the baseline's `29/8/4` traces to a rule + a named new row —
zero unexplained deltas. Capture the full report into
`staging/t0-reconcile-<date>.txt` for the W6 record:

```bash
cd server && npx tsx src/scripts/migrate-v4.ts --export "../staging/v4-export-cutover-$(date +%F)" \
  | tee ../staging/t0-reconcile-$(date +%F).txt
cd ..
```

## 6 · Go / no-go

| Outcome | Meaning | Action |
|---|---|---|
| All 9 sources readable + every delta rule-based with named rows | **GO** for the next gated step (production `--apply` at flip time — a separately scheduled, owner-attended step per CUTOVER-CHECKLIST §4 step 1) | record evidence on ISSUE-36 |
| Any source unreadable / HTTP ≠ 200 | ABORT | do **not** delete anything; investigate credentials/project state; note: Firebase readability is itself a W6 precondition |
| Any NEW unexplained delta | ABORT | park W6; investigate the delta class before any further decommission work |

## House rules (unchanged, enforced by tooling)

- Frozen baseline directory is never written (exporter refuses the path).
- Export contents never printed — counts + hashes only.
- Secrets stay in gitignored `staging/` with 0600; token expires ≤ 1 h.
- This runbook creates **no v5 writes**: dry-run inserts nothing; nothing here
  touches Render, production, or the live DB.
