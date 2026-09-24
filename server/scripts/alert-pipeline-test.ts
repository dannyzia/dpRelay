/**
 * One-off end-to-end proof of the ops alert pipeline: boots the real app
 * against a temp DB, registers a user, inserts a device with an ancient
 * last_seen_at, runs one watchdog pass, and reports whether the alert was
 * delivered via webhook or fell back to log-only. Secrets never printed.
 */
process.env.DB_PATH = "/tmp/dprelay-alert-proof.db";
process.env.JWT_SECRET = "alert-proof-jwt-secret-0123456789abcdef0123456789abcdef";
process.env.WATCHDOG_STALE_SEC = "1";
process.env.LOG_LEVEL = "info";
process.env.ALERT_WEBHOOK_URL = process.env.PROOF_ALERT_URL ?? "";
process.env.ALERT_WEBHOOK_SECRET = process.env.PROOF_ALERT_SECRET ?? "";

// Re-runnable: a leftover temp DB from a previous run would crash the seed
// with UNIQUE constraint errors.
const { rmSync } = await import("node:fs");
rmSync(process.env.DB_PATH, { force: true });

import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/services/crypto.js";

const app = buildApp({ startCron: false, runBootSweep: false, enableWakeGuard: false });

const userId = crypto.randomUUID();
const passwordHash = await hashPassword("alert-proof-password");
app.db
  .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, unixepoch())")
  .run(userId, "alert-proof@example.com", passwordHash);
// Ancient heartbeat: guaranteed to breach WATCHDOG_STALE_SEC=1.
app.db
  .prepare(
    "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, created_at) " +
      "VALUES (?, ?, 'alert-proof-phone', ?, unixepoch() - 99999, 1, unixepoch())",
  )
  .run(crypto.randomUUID(), userId, "not-a-real-key-hash");

const stale = await app.runWatchdog();
console.log(`stale devices found: ${stale.length}`);
await app.close();
