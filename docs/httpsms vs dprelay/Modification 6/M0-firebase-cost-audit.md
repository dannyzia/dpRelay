# M0 — Firebase Cost Audit (owner-provided billing export)

| | |
|---|---|
| **Source** | `~/Desktop/Firebase Payment_Reports, 2025-09-01 — 2026-09-30.csv` (Google Cloud billing "Payment report" export) |
| **Period** | 2025-09-01 → 2026-09-30 (full window in one report) |
| **Verdict** | Current Firebase spend is **small but structurally non-zero** — $0.45 actual against $2.73 list for the whole period. The exit case is not "escape a big bill"; it is "escape a bill that grows with traffic and requires the Blaze plan to deploy at all." |

## Line items

| Service | List ($) | Actual after credits ($) | Note |
|---|---:|---:|---|
| Cloud Run Functions | 2.30 | **0.01** | Free-tier credits absorbed nearly everything so far |
| Secret Manager | 0.24 | **0.24** | Fully billed — secrets storage for functions |
| Cloud Scheduler | 0.19 | **0.19** | Fully billed — `cleanupOldRequests` / bulk jobs |
| Cloud Storage | 0.00 | 0.00 | Negligible |
| **Subtotal** | 2.73 | **0.44** | |
| Tax | | 0.00 | |
| **Total** | | **0.45** | |

## Interpretation for Modification 6

1. **Cost pressure is currently low** — the honest headline. The recurring pieces are Secret Manager + Scheduler, which exist to serve Cloud Functions; both disappear with the Functions stack.
2. **The real costs are latent, not in this CSV:** (a) Functions v2 *deployment* requires Blaze — a plan-level constraint regardless of spend; (b) RTDB concurrency caps and egress scale with adoption; (c) Cloud Run Functions' free-tier absorption ("Other savings −$2.29") shrinks as invocations grow — polling (`checkAuth` every ~2s per waiting user) is the growth vector. The v5 webhook-first inversion (PLAN.md §3) removes that vector.
3. **Migration baseline:** with v4 spend this low, there is no hard financial deadline — M4 cutover is driven by architecture (Blaze independence + connection caps), not savings. Expected steady-state after cutover: **$0/month** (PLAN.md §12).

*Numbers transcribed verbatim from the CSV; re-export after M4 cutover for the final before/after comparison.*
