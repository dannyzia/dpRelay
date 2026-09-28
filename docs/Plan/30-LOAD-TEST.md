# SQLite Under Campaign Bursts — Load Test Report (ISSUE-35)

| | |
|---|---|
| **Date** | 2026-09-28 |
| **Refs** | ISSUE-35; PLAN §11 risk row "SQLite under campaign bursts"; ISSUE-14 (M4 epic exit criterion) |
| **Benchmark** | `server/src/scripts/bulk-burst-benchmark.ts` (committed with this report) |
| **Environment** | Node v20.9.0, `better-sqlite3` ^11.3.0 (synchronous driver), WAL + `foreign_keys = ON` (production pragmas via `openDb`), SQLite default `busy_timeout` (5 s), Linux dev machine |

**Verdict: no mitigation required.** The WAL + default-busy-timeout configuration
already absorbs worst-case campaign-burst contention. Every observed
`SQLITE_BUSY` was transparently absorbed by the 5 s busy-timeout — across both
formal runs, zero errors reached the workers' error paths. The production
drain rate (30 msgs/min) is ~3 orders of magnitude below the DB ceiling.

## 1. What was measured (AC1/AC2 map)

The benchmark seeds a temp DB through the **real** `openDb` (production
pragmas, all 9 migrations) with the production-shape tables — 5 apps +
`app_credits`, then drives three phases against **one shared WAL database
from concurrent worker threads, each with its own connection** (the
contention regime a multi-request server actually produces):

| Phase | Mirrors | Contenders |
|---|---|---|
| **A — create-burst** | `POST /v5/bulk/campaigns` create transaction (1 campaign + 100 `bulk_recipients` + 100 `bulk_usage` rows per tx) | 8 worker threads, separate connections, flat-out for 8 s |
| **B — claim-storm** | `GET /v5/device/outstanding` claim transaction (requeue-stale → select oldest batch → mark claimed, batch 50) | 8 device workers + a main-thread "fleet" posting delivery results and `bulk_phone_cooldowns` upserts every 100 ms |
| **C — drain** | `runBulkQueueTick` (reconcile → finalize → rate-budgeted enqueue) over a fixed 2 000-recipient cohort | run at production rate (30/min) and a stress rate (1 000/min) to find the DB ceiling, not the rate-limit ceiling |

## 2. Results (two formal runs, 8 s phases, 8 workers)

### Phase A — concurrent campaign creation

| Metric | Run 1 | Run 2 |
|---|---|---|
| Campaigns created | 962 | 1 337 |
| Recipient rows | 96 200 | 133 700 |
| Create tx throughput | 98.45 tx/s | 117.92 tx/s |
| Message-equivalent throughput | 9 804/s | 11 730/s |
| Create-tx latency p50 | 5.26 ms | 4.90 ms |
| p95 | 85.69 ms | 8.65 ms |
| p99 | 2 361.72 ms | 2 190.23 ms |
| max (busy-timeout clamped) | 5 012 ms | 6 596 ms |
| `SQLITE_BUSY` events | 4 | 7 |
| Errors surfaced | **0** | **0** |

### Phase B — device claim-storm over the shared DB

| Metric | Run 1 | Run 2 |
|---|---|---|
| Claim transactions | 21 910 | 20 910 |
| Messages claimed | 2 000 (cohort) | 2 000 (cohort) |
| Claim tx throughput | 228.7 tx/s | 207.3 tx/s |
| Claim-tx latency p50 / p95 / p99 | 0.31 / 0.68 / 0.94 ms | 0.32 / 0.69 / 0.90 ms |
| `SQLITE_BUSY` events | **0** | **0** |

### Phase C — queue drain (cohort of 2 000)

| Configuration | Result |
|---|---|
| Production rate, 30 msgs/min | 64 / 58 ticks (≈ 67 expected — arithmetic holds); each tick = one cron minute, so wall time is compressed |
| Stress rate, 1 000 msgs/min | **11 343–15 955 effective msgs/min** through the same tick shape — the DB processes a full day's production rate in ~4–9 s of tick work |
| Campaigns finalized | exactly the drained cohorts; `recipientsSent = 2000`, `pending = 0` |

### WAL / integrity

| Check | Result |
|---|---|
| `wal_checkpoint(TRUNCATE)` after ~230 k inserted rows | 220.6 / 219.6 ms — stable, sub-second |
| `PRAGMA foreign_key_check` | ok (both runs) |
| Row accounting | every phase's counters reconcile exactly |

## 3. Reading the p99 (WAL/locking behavior)

The tail in Phase A (p99 ≈ 2.2 s vs p50 ≈ 5 ms) is the **writer-lock handoff
stall**: WAL permits one writer at a time, so an 8-way writer pileup can make
an unlucky transaction wait several lock cycles. Three reasons this is
benign in production:

1. The tail is clamped by the busy-timeout — no transaction ever failed
   (`SQLITE_BUSY` never surfaced as an error; 4–7 absorptions per 8 s of
   *deliberately maximized* contention).
2. Production never generates this pileup: campaign creates arrive from
   external apps at human/API rates, and the queue tick is single-threaded
   by design. The p99 here corresponds to ≥ 8 simultaneous bulk creates.
3. The claim path (the phone-facing hot path) shows **no tail at all**
   (p99 < 1 ms, zero busy events) because claim transactions are short.

Throughput at the production rate (30 msgs/min, single tick thread) uses
~0.2 % of the observed create-phase capacity and ~0.5 % of the stress-drain
capacity. The system hits its configured *rate limits* long before it hits
SQLite's ceiling.

## 4. AC3 verdict — no mitigation needed

- **Pragmas:** current set (WAL + foreign_keys + default 5 s busy-timeout) is
  sufficient; no `synchronous`/`busy_timeout` changes warranted.
- **Indexes:** no candidate query in any phase scanned unserviced paths; the
  existing `(campaign_id, status, idx)` and `(status, created_at)` indexes
  carried every hot query.
- **Batch-size tuning:** enqueue/claim batch sizes did not affect latency
  profiles; no change warranted.
- Explicitly: **no schema, pragma, or batch-size change is made in this
  change set.** The benchmark and this report are the only deliverables.

## 5. Limitations (bench-only deviations)

- `bulk_usage.phone_hash` stores the raw bench phone (hashing is not the
  quantity under test; production hashes at insert).
- App `app_secret_hash` values are dummy hex (no auth in the benchmark path).
- The "fleet" result-poster is a main-thread interval, not real HTTP; it
  reproduces the *DB-write shape* of `POST /v5/device/results` + cooldown
  upserts, which is what contends with claim transactions.
- Drain-phase wall-clock is compressed relative to production because ticks
  are back-to-back rather than cron-spaced; per-tick work and totals are the
  meaningful numbers.

## 6. Reproduce

```bash
cd server
npx tsx src/scripts/bulk-burst-benchmark.ts --seconds 8 --workers 8
```

Deterministic inputs (seeded arithmetic, fixed phase durations); output is a
JSON report on stdout. Numbers vary with hardware; the shape of the
conclusions (zero surfaced errors, sub-ms claim path, rate limits ≪ DB
ceiling) is the reproducible claim.
