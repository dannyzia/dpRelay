# v4 → v5 Import Reconciliation Report

| | |
|---|---|
| **Date** | 2026-09-25 |
| **Refs** | ISSUE-22 (M4 pass 4 leftovers), Rhizome ISSUE-14 epic, fable5-v2 queue Workstream 3 |
| **Script state** | `server/src/scripts/migrate-v4.ts` at master `6656179` + this branch's fixes (§7) |
| **Command** | `npx tsx src/scripts/migrate-v4.ts --export <local export copy> --apply --db <local db>` (from `server/`) |
| **Scope** | **LOCAL copy only.** The frozen export `staging/v4-export-final-2026-09-19/` was never touched; the run used a copy at `staging/v4-import-work-2026-09-25/` (gitignored, along with the produced DB `v5-import.db` and the 0600 `v4-import-app-secrets.json`). Production import remains a separately gated step. |

**Verdict: reconciliation CLEAN — zero unexplained deltas.** Every delta between
the 56 exported v4 rows and the 29 imported v5 rows has a rule-based cause that
is deterministic, documented, and re-derivable. This report is the evidence
artifact gating Workstream 6 (decommission).

## 1. Source inventory (frozen export, 2026-09-19 manifest)

| Source | Rows | Manifest sha256 (prefix) |
|---|---|---|
| rtdb/registered_apps | 11 | `2b5875a1…` |
| rtdb/stats | 11 | `79ff6fa7…` |
| rtdb/config | 2 | `7bbc82fa…` |
| rtdb/health | 2 | `9703378c…` |
| firestore/packages | 20 | `8a761842…` |
| firestore/transactions | 5 | `bfeaffba…` |
| firestore/app_credits | 3 | `51aaba80…` |
| firestore/contactGroups | 1 | `ff1a0e6d…` |
| firestore/messageTemplates | 1 | `3dad7c7b…` |
| **Total** | **56** | — |

The local copy was byte-identical to the frozen export (plain `cp -r`; nothing
wrote into the copy's source trees).

## 2. Transform outcome (deterministic)

```
TOTAL: rows=56 imported=29 skipped=8 orphans=4
deterministic checks: packages=12 apps=11 transactions=3 creditRows=3
trx_id uniqueness: 2 attached, 0 duplicates
```

(`packages=12` = 12 distinct package codes after v4's 20 docs collapsed onto
their names; the script's per-bucket counters account for every row.)

## 3. Post-apply verification (local import DB)

| Check | Result |
|---|---|
| schema_migrations applied | 001–009 (all, via `openDb`) |
| packages / apps / credit_transactions / app_credits rows | 12 / 11 / 3 / 3 |
| transactions with attached TrxID | 2 (0 duplicates — partial-UNIQUE invariant holds) |
| PRAGMA integrity_check | ok |
| PRAGMA foreign_key_check violations | 0 |
| apps with 64-hex `app_secret_hash` | 11 / 11 (no plaintext app secrets anywhere) |
| apps with raw `webhook_secret` | 11 (by design: the server signs HMAC deliveries, 005) |
| Idempotent re-run | inserts 0 new rows; existing secrets file untouched |

## 4. Per-table reconciliation: source vs imported

| Table | Source rows | Imported | Skipped | Orphans | Explanation of every delta |
|---|---|---|---|---|---|
| packages | 20 docs | 12 | 8 | 0 | v4 names collapse onto `package_code` (slugify): duplicates and test packages (`Test OTP`, `Test Bulk`, `DevTester`) map to already-inserted codes → `ON CONFLICT DO NOTHING`. 12 distinct codes: bulk-enterprise, bulk-pro, bulk-starter, devtester, enterprise, enterprise-max, pro, pro-max, starter, test-bulk, test-otp, ultimate. |
| registered_apps → apps | 11 | 11 | 0 | 0 | 1:1 uuid → `sdk-<first8>`; inactive v4 apps imported **revoked**. bcrypt `apiKeyHash`es NOT carried (cannot be verified by v5's sha256 middleware); each imported app got a fresh secret hashed at rest, raw returned once in the 0600 file. |
| billing_apps → apps | — | (included in apps=11) | — | — | v4 owner identities (emails) from transactions/app_credits map to v5 apps; here they resolved to already-imported SDK apps (no extra rows). |
| transactions → credit_transactions | 5 | 3 | 0 | 2 | 1 orphan: references a package doc that did not map. 1 orphan: duplicate TrxID (`v4-TX_225544`) — v4 double-award suspect; earliest kept per Addendum #1, later classed orphan. 2 TrxIDs attached, 0 duplicates survive. |
| app_credits | 3 | 3 | 0 | 0 | Latest snapshot per app (v4 type split preserved: otp/bulk remaining + expiries). |
| contactGroups | 1 | 0 | 0 | 1 | uid-keyed (Firebase user) — no v5 owner mapping exists; classed orphan **by design**, not imported. |
| messageTemplates | 1 | 0 | 0 | 1 | Same uid-keyed orphan rule as contactGroups. |
| stats | 11 | 0 | 0 | 0 | v4 aggregate counters — v5 regenerates via its own stats tick; not imported. |
| config | 2 | 0 | 0 | 0 | v4 flags (`bulk_enabled`, `sms_paused`) map to v5 env/config, not rows. |
| health | 2 | 0 | 0 | 0 | v4 device health — v5 devices are server-minted; not imported. |

Sum check: imported 29 = 12 (package seeds) + 11 (apps) + 3 (transactions) + 3 (credits); skipped 8 = 8 collapsed package docs; orphans 4 = 1 unmapped-package transaction + 1 duplicate-TrxID transaction + 1 contactGroup + 1 messageTemplate. **Every one of the 56 source rows is accounted for.**

## 5. Per-table checksums (this run; re-runs are byte-identical except secret-dependent columns)

Deterministic seeds mean re-runs against the same export reproduce identical
rows; the apps checksum covers secret-hash columns, so it pins THIS run's
minted secrets (any re-mint changes it — expected and documented):

| Table (ordering per erratum below) | Rows | sha256 (first 16 hex) |
|---|---|---|
| packages (ordered by `package_code`) | 12 | `69ca080d97d3f45a` |
| apps (PK `id`, all columns except raw `webhook_secret`) | 11 | `63994018d4f14179` |
| credit_transactions (PK `id`) | 3 | `711e6a259d324f79` |
| app_credits (PK `app_id`) | 3 | `d6fcdadec906bc59` |

Checksum method: `sha256(JSON.stringify(rows_ordered_as_listed))` via
better-sqlite3 `SELECT *` (apps excludes only the raw signing-secret column,
which is re-minted per run by design). Full rows stay in gitignored staging —
this report carries counts and hashes only.

**Review erratum (2026-09-25, ISSUE-22 review pass):** the review independently
re-derived every checksum from a fresh `--apply`: packages, credit_transactions,
and app_credits reproduce the originally published values exactly; packages'
ordering was the script's map order (`package_code`), not PK as originally
stated — corrected above. The original apps value (`edbf6ef46fbcb7ec`) pinned
the original run's minted secret hashes; a review-time verification re-apply
displaced the original return-once secrets file, so the work-dir pair was
regenerated self-consistently (fresh apply, integrity ok, 0 FK violations,
11/11 secrets verified against their hashes) and the apps value re-pinned to
the current run above. Counts, sum-check, and every §4 delta are unaffected.

## 6. Verified test app (reconciliation queries against production)

- `dprelay-prod-2` (credentials: gitignored `staging/production-app-credentials.json` at the time; since moved to the OS keyring as the `production-app-credentials` account — see `server/README.md`, registered 2026-09-20) was **verified live** against `https://dprelay-api-hug8.onrender.com`:
  - `GET /v5/billing/credits` with its credentials → **HTTP 200, `ok: true`**
  - negative control (same appId, wrong secret) → **HTTP 401 `invalid_app_secret`**
- **Superseded 2026-10-04 (ISSUE-52):** the `dprelay-prod-2` appSecret was exposed, so the app was revoked (its credentials now return `401 app_revoked`) and the standing app was reprovisioned as `dprelay-prod-3`; the `production-app-credentials` keyring account now holds the `-3` credentials. The verification above stands as the record of the 2026-09-20 check.
- No new registration was performed — the app already existed; this workstream verified it as the standing test app for reconciliation queries.

## 7. Script fixes made and verified in this workstream (PR ref added on merge)

The first `--apply` attempt failed, and the single-transaction rollback
protected the DB both times — the dry run cannot catch insert-time constraints
because it never inserts. Three fixes shipped in this branch:

1. **NaN timestamps → NOT NULL violation.** v4 test packages (`DevTester`, `Test Bulk`, `Test OTP`) were written without `updated_at`; `ts(undefined)` → `NaN` → SQLite stores `NULL`. Fix: `tsOr(value, fallback)` with a deterministic fallback (`updated_at` defaults to the row's own `created_at` — creation is its last update). No wall-clock fallbacks; re-runs stay byte-identical.
2. **FK targets bound to the wrong id space.** `credit_transactions.app_id` and `app_credits.app_id` reference `apps.id` (internal `stableId` UUID), but the transform bound the public appId string (`sdk-…`). Fix: resolve each mapping to its app seed and bind `appSeed.id`. This also fixed a latent same-bug in the credits map key (`credits` keyed by `appSeed.id`).
3. **Apply hardening.** Per-bucket error context (`[bucket] row — constraint`) so future failures name the row; `ON CONFLICT(app_id) DO NOTHING` on apps and app_credits (packages/transactions already had it); post-apply COUNT-based evidence; and true idempotent re-runs that report return-once secrets **only** for rows actually inserted (a re-run never rewrites the secrets file with values that would not open existing rows).

## 8. Gate for Workstream 6 (decommission)

Workstream 6 may only start when the owner gives explicit written go AND this
report is clean AND a fresh cutover-date re-export reconciles the same way.
This report establishes the local-run baseline: 56 source rows → 29 imports,
zero unexplained deltas, DB integrity verified. The production import must
reproduce §2/§3/§4 against a fresh export before any v4 teardown begins.

## 9 · Fresh-run addendum (2026-10-08, M4 pass 4 — ISSUE-76)

| | |
|---|---|
| **Date** | 2026-10-08 |
| **Refs** | ISSUE-76 (M4 pass 4), ISSUE-74 (Stage E / pass 3), owner queue directive: pass 3 → pass 4 → Stage D |
| **Code line** | Stage E head `93e0726` (server `5.3.8-alpha.0`, migrations 001–011) stacked off master `879fee5` |
| **Command** | `npx tsx src/scripts/migrate-v4.ts --export staging/v4-import-work-2026-10-08/export --apply --db staging/v4-import-work-2026-10-08/v5-import.db` (from `server/`) |
| **Scope** | LOCAL copy only, same rule as § header: the frozen export `staging/v4-export-final-2026-09-19/` was never written — whole-dir sha256 `6037492d…` identical before and after the run. Zero production interaction (no Render/R2/live-DB calls); the production import remains owner-gated at flip time (doc 28 row 3 / doc 32). |

**Purpose:** re-validate §2–§5 under current code before Stage D — notably
migrations **001→011** (§3's "001–009" is superseded: `010_device_quarantine`
and `011_job_state` also apply on a fresh DB) and the Stage E pass-3 work
(plane caps, OTP credit enforcement, pricing conformance).

**Verdict: reproduction CLEAN — every pinned deterministic value reproduces
byte-identically; §4's per-row delta rules all still hold.**

### 9.1 Run totals (identical to §2)

```
TOTAL: rows=56 imported=29 skipped=8 orphans=4
deterministic checks: packages=12 apps=11 transactions=3 creditRows=3
trx_id uniqueness: 2 attached, 0 duplicates
APPLIED. 11 new app secret(s) written to …/v4-import-work-2026-10-08/v4-import-app-secrets.json (0600)
Post-apply table counts: packages=12 apps=11 transactions=3 app_credits=3
```

### 9.2 Independent verification (fresh DB)

| Check | Result |
|---|---|
| `verify-apply-rehearsal.cjs` | **VERDICT: MATCHES** (exit 0) |
| `PRAGMA integrity_check` | ok |
| `PRAGMA foreign_key_check` | 0 violations |
| `schema_migrations` applied | **001–011** (all eleven; delta vs §3 documented above) |
| packages / apps / credit_transactions / app_credits | 12 / 11 / 3 / 3 |
| `contact_groups` / `message_templates` | 0 / 0 (orphan rule, §9.4) |
| trx_id attached / duplicates | 2 / 0 |
| apps with 64-hex `app_secret_hash` | 11 / 11; revoked: 1 |
| Idempotent re-run | inserts **0** new rows; secrets file byte-unchanged (sha256 before == after) |

> ⚠️ **FLAG (pre-existing, gitignored tooling, out of scope):** the verifier's
> "orphaned credits/transactions rows" lines print 3/3 because that query joins
> on the public `sdk-…` id space; the authoritative `foreign_key_check` (0
> violations, FKs bind the internal `apps.id` per §7 fix 2) shows the rows are
> attached. Verdict and EXPECTED block are unaffected.

### 9.3 Checksums (method per §5)

| Table | Pinned (§5) | Reproduced 2026-10-08 | Match |
|---|---|---|---|
| packages (ordered by `package_code`) | `69ca080d97d3f45a` | `69ca080d97d3f45a` | ✅ |
| credit_transactions (PK `id`) | `711e6a259d324f79` | `711e6a259d324f79` | ✅ |
| app_credits (PK `app_id`) | `d6fcdadec906bc59` | `d6fcdadec906bc59` | ✅ |
| apps (PK `id`, excl. raw `webhook_secret`) | `63994018d4f14179` | **`dc20304082a5b19f`** | re-pinned ⬇ |

The apps value is re-pinned to this run exactly as §5 contract-provides: the
column covers this run's freshly minted return-once secret hashes, so any new
apply displaces it. The §5 value pinned the previous run; **for this work dir
`dc20304082a5b19f` is the pin.** Counts, sum-check, and every §4 delta are
unaffected.

**Cross-code-line evidence:** an identical run on master `879fee5`
(`5.3.7-alpha.0`, pre-Stage E) reproduced the same three deterministic
checksums (`69ca080d…` / `711e6a25…` / `d6fcdade…`) — the transform is
insensitive to the Stage E delta. That run's artifacts are kept beside this
run's under `staging/v4-import-work-2026-10-08/master-run/` (gitignored).

### 9.4 Orphan rule re-ruled against migration 008

contactGroups (1) and messageTemplates (1) remain **orphans by design** even
though `008_contact_groups_templates.sql` now creates the v5 `contact_groups` /
`message_templates` tables: the blocker was never schema, it is identity — the
v4 docs are uid-keyed (Firebase auth users) and no v5 owner mapping exists (v5
apps are server-minted). The fresh import leaves both tables at 0 rows (verified
in §9.2). Importing them would be an owner-mapping decision, not a script
defect — candidate input for Stage D; until decided, §4's rule stands.

### 9.5 Pricing-conformance cross-ref (Stage E pass 3)

All 20 frozen v4 package docs violate owner pricing `price_bdt ==
sms_quota × 0.20` (e.g. 50→50 BDT, 20000→5600, 500→450). Since Stage E added
operator `GET /v5/admin/billing/pricing-conformance`, these now surface
automatically in the flip-day operator readout. Import behaviour is unchanged:
source values are written verbatim, **never repriced** — reconfirmed this run.
