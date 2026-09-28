/**
 * SQLite-under-campaign-bursts load benchmark (PLAN §11 risk row; ISSUE-35).
 *
 * Exercises the campaign queue path on a seeded SQLite DB mirroring the
 * production shape (apps + app_credits + bulk_campaigns/bulk_recipients/
 * bulk_usage + pending_sms claim columns) under concurrent burst conditions:
 *
 *   Phase A  create-burst — W worker threads, each with its OWN connection,
 *            each committing one transaction (campaign + 100 recipients +
 *            100 usage rows) as fast as possible for S seconds. Contention
 *            is real: separate connections on one WAL database.
 *   Phase B  claim-storm — W device workers repeatedly run the same
 *            transaction shape as GET /v5/device/outstanding (requeue stale
 *            claims → select oldest batch → mark claimed) while the main
 *            thread simulates delivery results + cooldown upserts — exactly
 *            what a live phone fleet produces.
 *   Phase C  drain — main-thread ticks replicate runBulkQueueTick's
 *            reconcile → finalize → rate-budgeted enqueue until the enqueued
 *            cohort completes. Run twice over the same cohort: at the
 *            production default rate (30/min) and at a stress rate
 *            (1000/min) to expose the SQLite ceiling rather than the
 *            rate-limit ceiling.
 *
 * Measured and reported (AC2): create throughput, claim-batch latency
 * distribution under contention, SQLITE_BUSY counts, WAL checkpoint timing,
 * effective drain rate. Deterministic: seeded arithmetic, fixed phase
 * durations, no wall-clock values in assertions — the script reports; it
 * never asserts thresholds.
 *
 * Bench-only simplifications (documented in docs/Plan/30-LOAD-TEST.md):
 * bulk_usage.phone_hash stores the raw bench phone (hashing is not the
 * thing under test), and app secret hashes are dummy hex.
 *
 * Usage: npx tsx src/scripts/bulk-burst-benchmark.ts [--seconds 3] [--workers 4]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../db.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? Number.parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

const SECONDS = arg("seconds", 3);
const WORKERS = arg("workers", 4);
const CAMPAIGN_BATCH = 100; // recipients per create-transaction
const ENQUEUE_COHORT = 2000; // recipients driven through the drain phases
const CLAIM_BATCH = 50; // OUTSTANDING_BATCH_LIMIT parity
const STRESS_RATE = 1000; // msgs/min for the ceiling probe

interface WorkerResult {
  count: number;
  latenciesMs: number[];
  busyCount: number;
  errors: string[];
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function dist(lat: number[]): { p50: number; p95: number; p99: number; max: number } {
  const s = [...lat].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] ?? 0 };
}

/**
 * Worker source written into server/node_modules/.bench-tmp/ so
 * require("better-sqlite3") resolves naturally and nothing TS/ESM has to
 * run inside a worker. The directory is deleted at the end.
 */
function spawnWorkers(
  workdir: string,
  script: string,
  count: number,
  payload: Record<string, unknown>,
): Promise<WorkerResult[]> {
  const workerPath = join(workdir, "worker.cjs");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(workerPath, script);
  const results: WorkerResult[] = [];  return Promise.all(
    Array.from({ length: count }, () => {
      return new Promise<void>((resolve, reject) => {
        const w = new Worker(workerPath, { workerData: payload });
        w.on("message", (m: WorkerResult) => results.push(m));
        w.on("error", reject);
        w.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
      });
    }),
  ).then(() => results);
}
const CREATE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const { randomUUID } = require("node:crypto");
const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const insCampaign = db.prepare(
  "INSERT INTO bulk_campaigns (id, app_id, name, message, charset, status, total_recipients, created_at) " +
  "VALUES (?, ?, ?, ?, 'gsm', 'queued', ?, ?)"
);
const insRecipient = db.prepare(
  "INSERT INTO bulk_recipients (id, campaign_id, phone, idx, status) VALUES (?, ?, ?, ?, 'pending')"
);
const insUsage = db.prepare(
  "INSERT INTO bulk_usage (id, campaign_id, phone_hash, deducted_at) VALUES (?, ?, ?, ?)"
);
const tx = db.transaction(() => {
  const campaignId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  insCampaign.run(campaignId, workerData.appRowId, "burst-" + randomUUID().slice(0, 8),
    "Load test campaign message", workerData.batch, now);
  for (let i = 0; i < workerData.batch; i++) {
    const n = String(700000000 + ((workerData.seed * 7919 + i * 104729 + workerData.tick) % 900000000));
    const phone = "+8801" + n.slice(0, 9);
    insRecipient.run(randomUUID(), campaignId, phone, i);
    insUsage.run(randomUUID(), campaignId, phone, now);
  }
  return campaignId;
});
let count = 0; const lat = []; let busy = 0; const errors = []; let tick = 0;
const deadline = Date.now() + workerData.seconds * 1000;
while (Date.now() < deadline) {
  workerData.tick = tick++;
  const t0 = performance.now();
  try { tx(); count += workerData.batch; }
  catch (e) {
    if (e && e.code === "SQLITE_BUSY") busy += 1;
    else errors.push(String(e && e.message).slice(0, 120));
  }
  lat.push(Math.round((performance.now() - t0) * 100) / 100);
}
parentPort.postMessage({ count, latenciesMs: lat, busyCount: busy, errors });
`;

const CLAIM_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const requeue = db.prepare(
  "UPDATE pending_sms SET status = 'pending', claimed_at = NULL, claimed_by = NULL " +
  "WHERE status = 'claimed' AND claimed_at < ?"
);
const select = db.prepare(
  "SELECT id FROM pending_sms WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?"
);
const mark = db.prepare(
  "UPDATE pending_sms SET status = 'claimed', claimed_at = ?, claimed_by = ?, claimed_count = claimed_count + 1 WHERE id = ?"
);
const claimTx = db.transaction((deviceId, now, requeueBefore, batch) => {
  requeue.run(requeueBefore);
  const rows = select.all(batch);
  for (const r of rows) mark.run(now, deviceId, r.id);
  return rows.length;
});
const now0 = Math.floor(Date.now() / 1000);
const requeueBefore = now0 - 999999; // never re-queues: row accounting stays exact
const device = "dev-worker-" + workerData.seed;
let count = 0; const lat = []; let busy = 0; const errors = [];
const deadline = Date.now() + workerData.seconds * 1000;
while (Date.now() < deadline) {
  const t0 = performance.now();
  try { count += claimTx(device, Math.floor(Date.now() / 1000), requeueBefore, workerData.batch); }
  catch (e) {
    if (e && e.code === "SQLITE_BUSY") busy += 1;
    else errors.push(String(e && e.message).slice(0, 120));
  }
  lat.push(Math.round((performance.now() - t0) * 100) / 100);
}
parentPort.postMessage({ count, latenciesMs: lat, busyCount: busy, errors });
`;

function seed(db: Db, apps: number): { appRowIds: string[] } {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run("u-bench", "bench@example.invalid", "bench-not-a-real-argon2-hash", now);
  db.prepare(
    "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, created_at) VALUES (?, 'u-bench', ?, ?, ?, ?)",
  ).run("dev-main", "bench-main", "k".repeat(64), now, now);
  // Claim workers set claimed_by, which is an FK to devices — they must exist.
  const insDevice = db.prepare(
    "INSERT INTO devices (id, user_id, label, api_key_hash, created_at) VALUES (?, 'u-bench', ?, ?, ?)",
  );
  for (let i = 1; i <= 12; i++) {
    insDevice.run(`dev-worker-${i}`, `bench-worker-${i}`, ("a".repeat(60) + String(i).padStart(4, "0")), now);
  }
  const appRowIds: string[] = [];
  const insApp = db.prepare(
    "INSERT INTO apps (id, app_id, app_secret_hash, name, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insCredit = db.prepare(
    "INSERT INTO app_credits (app_id, bulk_sms_remaining, updated_at) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < apps; i++) {
    const rowId = `app-row-${i}`;
    insApp.run(rowId, `bench-app-${i}`, "f".repeat(64), `Bench App ${i}`, now);
    insCredit.run(rowId, 1_000_000, now);
    appRowIds.push(rowId);
  }
  return { appRowIds };
}

/** Bench phone for a cohort position — deterministic, no Math.random. */
function benchPhone(i: number): string {
  return "+8801" + String(700000000 + (i % 900000000)).slice(0, 9);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dprelay-bench-"));
  const workdir = join(fileURLToPath(new URL("../../node_modules/.bench-tmp/", import.meta.url)));
  try {
    const dbPath = join(dir, "bench.db");
    const db = openDb(dbPath); // production pragmas: WAL + foreign_keys ON
    const { appRowIds } = seed(db, 5);
    const journal = (db.pragma("journal_mode", { simple: true }) as string).toUpperCase();
    const campaignMessage = "Load test campaign message";

    // ── Phase A: create-burst under contention ───────────────────────────
    const aStart = Date.now();
    const aResults = await spawnWorkers(workdir, CREATE_WORKER, WORKERS, {
      dbPath, seconds: SECONDS, batch: CAMPAIGN_BATCH, appRowId: appRowIds[0], seed: 1, tick: 0,
    });
    const aLat = aResults.flatMap((r) => r.latenciesMs);
    const aCount = aResults.reduce((s, r) => s + r.count, 0);
    const aBusy = aResults.reduce((s, r) => s + r.busyCount, 0);
    const aSecs = (Date.now() - aStart) / 1000;
    const campaignsCreated = (
      db.prepare("SELECT COUNT(*) AS n FROM bulk_campaigns").get() as { n: number }
    ).n;

    // ── Enqueue the drain cohort (same shape as the service's enqueue tx) ─
    const cohort = db
      .prepare("SELECT r.id, r.phone FROM bulk_recipients r WHERE r.status = 'pending' ORDER BY r.campaign_id, r.idx LIMIT ?")
      .all(ENQUEUE_COHORT) as { id: string; phone: string }[];
    const insPending = db.prepare(
      "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    );
    const markQueued = db.prepare("UPDATE bulk_recipients SET status = 'queued', pending_sms_id = ? WHERE id = ?");
    const cancelRest = db.prepare(
      "UPDATE bulk_recipients SET status = 'cancelled' WHERE status = 'pending'",
    );
    db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const r of cohort) {
        const pid = `ps1-${r.id}`;
        insPending.run(pid, "bench-app-0", r.phone, campaignMessage, now);
        markQueued.run(pid, r.id);
      }
      // Rows outside the cohort are excluded from the drain so phase C is
      // bounded and the finalize predicate can fire.
      cancelRest.run();
    })();

    // ── Phase B: claim-storm while the "fleet" reports results ───────────
    const resultPoster = setInterval(() => {
      try {
        db.transaction(() => {
          const now = Math.floor(Date.now() / 1000);
          const claimed = db
            .prepare(
              "SELECT p.id, r.phone FROM pending_sms p JOIN bulk_recipients r ON r.pending_sms_id = p.id " +
                "WHERE p.status = 'claimed' LIMIT 20",
            )
            .all() as { id: string; phone: string }[];
          const markSent = db.prepare(
            "UPDATE pending_sms SET status = 'sent', result_at = ? WHERE id = ? AND status = 'claimed'",
          );
          const cooldown = db.prepare(
            "INSERT INTO bulk_phone_cooldowns (phone, expires_at) VALUES (?, ?) " +
              "ON CONFLICT(phone) DO UPDATE SET expires_at = excluded.expires_at",
          );
          const closeRecipient = db.prepare(
            "UPDATE bulk_recipients SET status = 'sent', attempts = 1, last_attempt_at = ? WHERE pending_sms_id = ?",
          );
          for (const c of claimed) {
            markSent.run(now, c.id);
            closeRecipient.run(now, c.id);
            cooldown.run(c.phone, now + 120);
          }
        })();
      } catch {
        // A SQLITE_BUSY here just skips one poster beat; workers keep going.
      }
    }, 100);

    const bStart = Date.now();
    const bResults = await spawnWorkers(workdir, CLAIM_WORKER, WORKERS, {
      dbPath, seconds: SECONDS, batch: CLAIM_BATCH, seed: 2,
    });
    clearInterval(resultPoster);
    const bLat = bResults.flatMap((r) => r.latenciesMs);
    const bCount = bResults.reduce((s, r) => s + r.count, 0);
    const bBusy = bResults.reduce((s, r) => s + r.busyCount, 0);
    const bSecs = (Date.now() - bStart) / 1000;

    // ── Phase C: drain the cohort to completion, twice ────────────────────
    async function drain(ratePerMinute: number, round: 1 | 2): Promise<{
      ticks: number; drained: number; seconds: number; finalized: number;
    }> {
      // In-flight = not yet terminal: the cohort starts 'queued' (pre-enqueued
      // for the claim storm) and alternates pending/queued through the ticks.
      let remaining = (
        db.prepare("SELECT COUNT(*) AS n FROM bulk_recipients WHERE status IN ('pending', 'queued')").get() as { n: number }
      ).n;
      let ticks = 0;
      let drained = 0;
      let finalized = 0;
      const t0 = Date.now();
      while (remaining > 0) {
        ticks += 1;
        const tick = db.transaction(() => {
          const now = Math.floor(Date.now() / 1000);
          // reconcile: queued rows resolve as 'sent' (fully successful fleet)
          const resolved = db
            .prepare(
              "SELECT r.id, r.campaign_id, r.pending_sms_id FROM bulk_recipients r WHERE r.status = 'queued' LIMIT ?",
            )
            .all(ratePerMinute) as { id: string; campaign_id: string; pending_sms_id: string }[];
          for (const r of resolved) {
            db.prepare("UPDATE pending_sms SET status = 'sent', result_at = ? WHERE id = ?").run(now, r.pending_sms_id);
            db.prepare("UPDATE bulk_recipients SET status = 'sent', attempts = 1, last_attempt_at = ? WHERE id = ?").run(now, r.id);
            db.prepare("UPDATE bulk_campaigns SET sent_count = sent_count + 1 WHERE id = ?").run(r.campaign_id);
          }
          // enqueue under the rate budget (runBulkQueueTick shape)
          const budget = Math.max(0, ratePerMinute - resolved.length);
          let enq = 0;
          const campaigns = db
            .prepare("SELECT id FROM bulk_campaigns WHERE status IN ('queued', 'sending') ORDER BY created_at ASC, id ASC")
            .all() as { id: string }[];
          const perCampaign = Math.max(1, Math.floor(budget / Math.max(1, campaigns.length)));
          for (const c of campaigns) {
            if (enq >= budget) break;
            const take = Math.min(perCampaign, budget - enq);
            const recs = db
              .prepare("SELECT id, phone FROM bulk_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY idx ASC LIMIT ?")
              .all(c.id, take) as { id: string; phone: string }[];
            for (const r of recs) {
              const pid = `ps${round}-${r.id}`;
              db.prepare("INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
                .run(pid, "bench-app-0", r.phone, campaignMessage, now);
              db.prepare("UPDATE bulk_recipients SET status = 'queued', pending_sms_id = ? WHERE id = ?").run(pid, r.id);
              enq += 1;
            }
          }
          // finalize campaigns with no in-flight recipients
          const fin = db
            .prepare(
              "UPDATE bulk_campaigns SET status = 'completed', completed_at = ? " +
                "WHERE status = 'sending' AND NOT EXISTS (" +
                "SELECT 1 FROM bulk_recipients r WHERE r.campaign_id = bulk_campaigns.id AND r.status IN ('pending', 'queued'))",
            )
            .run(now);
          return { resolved: resolved.length, enqueued: enq, finalized: fin.changes };
        })();
        drained += tick.resolved;
        finalized += tick.finalized;
        remaining = (
          db.prepare("SELECT COUNT(*) AS n FROM bulk_recipients WHERE status IN ('pending', 'queued')").get() as { n: number }
        ).n;
      }
      return { ticks, drained, seconds: (Date.now() - t0) / 1000, finalized };
    }

    const drainProd = await drain(30, 1);
    // Reset the cohort for the stress round (round-2 pending_sms ids differ).
    db.transaction(() => {
      db.prepare("UPDATE bulk_recipients SET status = 'pending', attempts = 0, last_attempt_at = NULL WHERE status IN ('sent', 'failed') AND pending_sms_id LIKE 'ps1-%'")
        .run();
    })();
    const drainStress = await drain(STRESS_RATE, 2);

    const ckptStart = performance.now();
    db.pragma("wal_checkpoint(TRUNCATE)");
    const ckptMs = Math.round((performance.now() - ckptStart) * 100) / 100;

    const report = {
      meta: {
        date: new Date().toISOString(),
        node: process.version,
        journalMode: journal,
        foreignKeys: db.pragma("foreign_keys", { simple: true }),
        busyTimeoutDefaultMs: 5000,
        secondsPerPhase: SECONDS,
        workers: WORKERS,
        claimBatch: CLAIM_BATCH,
        campaignBatch: CAMPAIGN_BATCH,
        enqueueCohort: cohort.length,
      },
      phaseA_createBurst: {
        campaignsCreated,
        txCount: aLat.length,
        recipients: aCount,
        throughputTxPerSec: Math.round((aLat.length / aSecs) * 100) / 100,
        messagesPerSec: Math.round((aCount / aSecs) * 100) / 100,
        latencyMs: dist(aLat),
        sqliteBusy: aBusy,
        errors: aResults.flatMap((r) => r.errors).slice(0, 5),
      },
      phaseB_claimStorm: {
        claims: bCount,
        txCount: bLat.length,
        claimsPerSec: Math.round((bCount / bSecs) * 100) / 100,
        latencyMs: dist(bLat),
        sqliteBusy: bBusy,
        errors: bResults.flatMap((r) => r.errors).slice(0, 5),
      },
      phaseC_drain: {
        productionRate30PerMin: {
          ticks: drainProd.ticks,
          wallSeconds: Math.round(drainProd.seconds * 100) / 100,
          note: "each tick = one cron minute, so wall time is compressed; effective msgs/min = the rate itself",
        },
        stressRate1000PerMin: {
          ticks: drainStress.ticks,
          wallSeconds: Math.round(drainStress.seconds * 100) / 100,
          effectiveMsgsPerMin: Math.round((drainStress.drained / Math.max(drainStress.seconds, 0.001)) * 60),
        },
      },
      walCheckpointTruncateMs: ckptMs,
      integrity: {
        foreignKeyCheck: db.pragma("foreign_key_check", { simple: true }) === undefined ? "ok" : "violations",
        finalCounts: {
          campaigns: (db.prepare("SELECT COUNT(*) AS n FROM bulk_campaigns").get() as { n: number }).n,
          recipientsSent: (db.prepare("SELECT COUNT(*) AS n FROM bulk_recipients WHERE status = 'sent'").get() as { n: number }).n,
          recipientsPending: (db.prepare("SELECT COUNT(*) AS n FROM bulk_recipients WHERE status = 'pending'").get() as { n: number }).n,
        },
      },
    };

    console.log(JSON.stringify(report, null, 2));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("benchmark failed:", e);
  process.exit(1);
});
