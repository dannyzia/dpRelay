/**
 * M4 pass 4 — v4 export → v5 SQLite transform + seed + reconciliation report.
 *
 * DRY RUN (default): validates the export, computes the full transform in
 * memory, prints the row-by-row reconciliation report, and writes NOTHING.
 * APPLY: `node dist/scripts/migrate-v4.js --apply --db <path>` executes the
 * same deterministic transform against the real database inside one
 * transaction (all-or-nothing).
 *
 * House rules honored here:
 * - Deterministic IDs: v5 internal ids derive from stable v4 identifiers
 *   (SHA-256 → UUIDv5) so re-runs are idempotent and report == applied.
 * - Secrets stay secrets: new app secrets are random, returned once in a
 *   0600 file, hashed at rest. v4's bcrypt apiKeyHashes cannot be verified
 *   by v5's sha256 middleware, so they are not carried over.
 * - v4 read-only: the script never contacts Firebase.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const V5_NAMESPACE = "b7e6f3a2-0c4d-4e8f-9a1b-2d3c5e6f7a8b";

/** Structured counters for the reconciliation report. */
const report = {
  sources: {} as Record<string, { rows: number; imported: number; skipped: number; orphans: number; notes: string[] }>,
};

function bucket(name: string) {
  report.sources[name] ??= { rows: 0, imported: 0, skipped: 0, orphans: 0, notes: [] };
  return report.sources[name];
}

function note(name: string, msg: string) {
  const b = bucket(name);
  if (!b.notes.includes(msg)) b.notes.push(msg);
}

/** Unwraps Firestore REST `{{ stringValue }}` typed values into plain JSON. */
function unwrap(fields: Record<string, { stringValue?: string; integerValue?: string; booleanValue?: boolean; timestampValue?: string }>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) out[k] = Math.floor(new Date(v.timestampValue).getTime() / 1000);
    else out[k] = null;
  }
  return out;
}

/**
 * Deterministic v5 internal id from a stable v4 identity: sha256 over
 * (namespace, kind, key), rendered as a version-5-shaped UUID. Node has no
 * built-in UUIDv5; the bit-math here follows RFC 4122 §4.3 so ids are stable
 * across runs and machines without adding a dependency.
 */
function stableId(kind: string, key: string): string {
  const h = createHash("sha256").update(`${V5_NAMESPACE}|${kind}|${key}`).digest();
  const b = [...h.subarray(0, 16)];
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function ts(v: unknown): number {
  return typeof v === "number" ? v : Math.floor(new Date(String(v)).getTime() / 1000);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dbIdx = args.indexOf("--db");
const exportIdx = args.indexOf("--export");
if (APPLY && dbIdx === -1) {
  console.error("--apply requires --db <path to dprelay.db>");
  process.exit(2);
}
const EXPORT_DIR = exportIdx !== -1 ? args[exportIdx + 1] : "staging/v4-export-final-2026-09-19";
const DB_PATH = dbIdx !== -1 ? args[dbIdx + 1] : undefined;

// ── Load export (values stay on disk / in memory — never printed) ─────────
const read = (p: string) => JSON.parse(readFileSync(`${EXPORT_DIR}/${p}`, "utf8"));
const rtdb = {
  registeredApps: read("rtdb/registered_apps.json") as Record<string, RegisteredApp>,
  stats: read("rtdb/stats.json") as Record<string, unknown>,
  config: read("rtdb/config.json") as Record<string, unknown>,
  health: read("rtdb/health.json") as Record<string, unknown>,
};
const fstore = {
  packages: read("firestore/packages.json"),
  transactions: read("firestore/transactions.json"),
  appCredits: read("firestore/app_credits.json"),
  contactGroups: read("firestore/contactGroups.json"),
  messageTemplates: read("firestore/messageTemplates.json"),
};

interface RegisteredApp {
  active: boolean;
  apiKeyHash: string;
  createdAt: number;
  name: string;
  rateLimit: { max?: number; windowSec?: number } | Record<string, unknown>;
  smsTemplate: string;
}

// ── Transform (deterministic) ──────────────────────────────────────────────
interface PackageSeed {
  id: string; package_code: string; name: string; sms_quota: number;
  price_bdt: number; validity_days: number; type: string; is_active: number;
  created_at: number; updated_at: number;
}
interface AppSeed {
  id: string; app_id: string; app_secret_hash: string; name: string;
  webhook_url: string | null; webhook_secret: string | null; webhook_secret_hash: string | null;
  rate_max_per_phone: number; rate_window_sec: number; created_at: number; revoked_at: number | null;
}
interface TxSeed {
  id: string; app_id: string; package_id: string; package_code: string;
  sms_quota: number; validity_days: number; amount_bdt: number; package_type: string;
  trx_id: string | null; status: string; admin_notes: string | null; resolved_by: string | null;
  requested_at: number; resolved_at: number | null;
}
interface CreditSeed {
  app_id: string; otp_sms_remaining: number; bulk_sms_remaining: number;
  otp_expires_at: number | null; bulk_expires_at: number | null;
  last_transaction_id: string | null; purchased_at: number | null; updated_at: number;
}

const secretsOut: { app_id: string; appSecret: string }[] = [];
const packages = new Map<string, PackageSeed>();   // by v5 package_code
const packagesByV4Id = new Map<string, string>();  // v4 package doc-id → v5 package_code
const apps = new Map<string, AppSeed>();           // by v5 app_id
const appsByV4Id = new Map<string, string>();      // v4 appId/uid → v5 app_id
const transactions: TxSeed[] = [];
const credits = new Map<string, CreditSeed>();     // by v5 app_id

// 1. Packages (Firestore): package_code derived from the v4 name.
for (const doc of fstore.packages.documents) {
  const f = unwrap(doc.fields);
  const b = bucket("packages");
  b.rows += 1;
  const name = String(f.name);
  const code = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(code)) {
    b.skipped += 1;
    note("packages", `unmappable name → package_code (doc ${doc.name.split("/").pop()})`);
    continue;
  }
  if (packages.has(code)) {
    b.skipped += 1;
    note("packages", "duplicate v4 name collapsed to one package_code");
    continue;
  }
  const id = stableId("package", code);
  packages.set(code, {
    id, package_code: code, name,
    sms_quota: Number(f.sms_quota), price_bdt: Number(f.price_bdt),
    validity_days: Number(f.validity_days), type: String(f.type),
    is_active: f.is_active ? 1 : 0,
    created_at: ts(f.created_at), updated_at: ts(f.updated_at),
  });
  packagesByV4Id.set(String(doc.name.split("/").pop()), code);
  b.imported += 1;
}

// 2. SDK apps (RTDB registered_apps): uuid → v5 appId `sdk-<first8>`.
for (const [v4Id, ra] of Object.entries(rtdb.registeredApps)) {
  const b = bucket("registered_apps");
  b.rows += 1;
  const appId = `sdk-${v4Id.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
  if (apps.has(appId)) {
    b.skipped += 1;
    continue;
  }
  const secret = randomBytes(24).toString("base64url");
  const webhookSecret = randomBytes(24).toString("base64url");
  const id = stableId("app", appId);
  apps.set(appId, {
    id, app_id: appId, app_secret_hash: sha256Hex(secret), name: String(ra.name ?? appId),
    webhook_url: null, webhook_secret: webhookSecret, webhook_secret_hash: sha256Hex(webhookSecret),
    rate_max_per_phone: Number((ra.rateLimit as { max?: number })?.max ?? 3) || 3,
    rate_window_sec: Number((ra.rateLimit as { windowSec?: number })?.windowSec ?? 3600) || 3600,
    created_at: Number(ra.createdAt ?? 0) || Math.floor(Date.now() / 1000),
    revoked_at: ra.active === false ? Math.floor(Date.now() / 1000) : null,
  });
  secretsOut.push({ app_id: appId, appSecret: secret });
  appsByV4Id.set(v4Id, appId);
  b.imported += 1;
  if (ra.active === false) note("registered_apps", "inactive v4 app imported revoked");
}

// 3. Billing apps (Firestore transactions/app_credits carry appId emails).
const billingAppIds = new Set<string>();
for (const doc of fstore.transactions.documents) billingAppIds.add(String(unwrap(doc.fields).appId));
for (const doc of fstore.appCredits.documents) billingAppIds.add(String(unwrap(doc.fields).appId));
for (const rawAppId of billingAppIds) {
  if (appsByV4Id.has(rawAppId) || apps.has(rawAppId)) continue;
  const b = bucket("billing_apps");
  b.rows += 1;
  const appId = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawAppId)
    ? rawAppId.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 50)
    : rawAppId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 50);
  const secret = randomBytes(24).toString("base64url");
  const webhookSecret = randomBytes(24).toString("base64url");
  const id = stableId("app", appId);
  apps.set(appId, {
    id, app_id: appId, app_secret_hash: sha256Hex(secret), name: rawAppId,
    webhook_url: null, webhook_secret: webhookSecret, webhook_secret_hash: sha256Hex(webhookSecret),
    rate_max_per_phone: 3, rate_window_sec: 3600,
    created_at: Math.floor(Date.now() / 1000), revoked_at: null,
  });
  secretsOut.push({ app_id: appId, appSecret: secret });
  appsByV4Id.set(rawAppId, appId);
  b.imported += 1;
  note("billing_apps", "v4 owner identity (email/uid) became a v5 app; secret return-once in 0600 file");
}// 4. Transactions (Firestore): two-pass — map every doc, then dedupe TrxIDs
// keeping the EARLIEST as the award record (v4's approve path never re-checked
// uniqueness — the double-award class v5's partial-UNIQUE invariant forbids).
interface TxMapped extends TxSeed { docId: string }
const txMapped: TxMapped[] = [];
let txUnmapped = 0;
for (const doc of fstore.transactions.documents) {
  const f = unwrap(doc.fields);
  const appId = appsByV4Id.get(String(f.appId));
  const packageCode = packagesByV4Id.get(String(f.package_id));
  if (!appId || !packageCode) {
    txUnmapped += 1;
    continue;
  }
  const pkg = packages.get(packageCode)!;
  const status = String(f.status) === "approved" ? "approved" : String(f.status) === "rejected" ? "rejected" : "pending";
  txMapped.push({
    docId: String(doc.name.split("/").pop() ?? ""),
    id: stableId("txn", String(doc.name.split("/").pop())),
    app_id: appId, package_id: pkg.id, package_code: packageCode,
    sms_quota: Number(f.sms_quota), validity_days: Number(f.validity_days),
    amount_bdt: Number(f.amount_bdt), package_type: pkg.type,
    // TrxIDs are unique, material, and already used — never re-awardable in v5.
    trx_id: f.trx_id ? `v4-${f.trx_id}` : null,
    status,
    admin_notes: f.admin_notes === null ? null : `v4 import: ${String(f.admin_notes)}`,
    resolved_by: "v4-import",
    requested_at: ts(f.requested_at),
    resolved_at: f.approved_at ? ts(f.approved_at) : null,
  });
}
const byTrx = new Map<string, TxMapped>(); // trx_id → earliest
const txDropped: TxMapped[] = [];
for (const t of txMapped) {
  if (t.trx_id === null) continue;
  const seen = byTrx.get(t.trx_id);
  if (seen === undefined) {
    byTrx.set(t.trx_id, t);
  } else if (t.requested_at < seen.requested_at) {
    txDropped.push(seen);
    byTrx.set(t.trx_id, t);
  } else {
    txDropped.push(t);
  }
}
const txSurvivors = txMapped.filter((t) => !txDropped.includes(t));
transactions.push(...txSurvivors);
{
  const b = bucket("transactions");
  b.rows = fstore.transactions.documents.length;
  b.imported = txSurvivors.length;
  b.orphans = txUnmapped + txDropped.length;
  if (txUnmapped > 0) note("transactions", "orphan: transaction references an app/package that did not map");
  if (txDropped.length > 0) note("transactions", `orphan: ${txDropped.length} duplicate TrxID(s) — v4 double-award suspects; earliest kept, later classed as orphan`);
}

// 5. App credits (Firestore): latest balances per appId, v4 type split.
for (const doc of fstore.appCredits.documents) {
  const f = unwrap(doc.fields);
  const b = bucket("app_credits");
  b.rows += 1;
  const appId = appsByV4Id.get(String(f.appId));
  if (!appId) {
    b.orphans += 1;
    note("app_credits", "orphan: credits row references an unmapped appId");
    continue;
  }
  const prev = credits.get(appId);
  const newer = !prev || Number(f.updated_at) > prev.updated_at;
  if (!newer) {
    b.skipped += 1;
    note("app_credits", "superseded older snapshot for the same app kept the newest");
    continue;
  }
  credits.set(appId, {
    app_id: appId,
    otp_sms_remaining: Number(f.sms_remaining ?? 0),
    bulk_sms_remaining: Number(f.bulk_sms_remaining ?? 0),
    otp_expires_at: f.expires_at === null ? null : Number(f.expires_at),
    bulk_expires_at: f.bulk_expires_at === null ? null : Number(f.bulk_expires_at),
    last_transaction_id: null,
    purchased_at: ts(f.purchased_at),
    updated_at: ts(f.updated_at),
  });
  b.imported += 1;
}

// 6. uid-keyed groups/templates: ORPHANS by design (no v5 owner mapping).
bucket("contactGroups").rows = fstore.contactGroups.documents.length;
bucket("contactGroups").orphans = fstore.contactGroups.documents.length;
note("contactGroups", "uid-keyed (Firebase user) — no v5 owner mapping exists; classed as orphan, not imported");
bucket("messageTemplates").rows = fstore.messageTemplates.documents.length;
bucket("messageTemplates").orphans = fstore.messageTemplates.documents.length;
note("messageTemplates", "uid-keyed (Firebase user) — no v5 owner mapping exists; classed as orphan, not imported");
bucket("stats").rows = Object.keys(rtdb.stats).length;
note("stats", "v4 aggregate counters — v5 regenerates via its own stats tick; not imported");
bucket("config").rows = Object.keys(rtdb.config).length;
note("config", "v4 flags (bulk_enabled, sms_paused) map to v5 env/config — not imported as rows");
bucket("health").rows = Object.keys(rtdb.health).length;
note("health", "v4 device health entries — v5 devices table is server-minted; not imported");

// ── Reconciliation report ─────────────────────────────────────────────────
let totalRows = 0, totalImported = 0, totalSkipped = 0, totalOrphans = 0;
console.log("\n================ v4 → v5 RECONCILIATION REPORT ================");
console.log(`export: ${EXPORT_DIR}`);
for (const [name, s] of Object.entries(report.sources)) {
  totalRows += s.rows; totalImported += s.imported; totalSkipped += s.skipped; totalOrphans += s.orphans;
  console.log(`\n${name}: rows=${s.rows} imported=${s.imported} skipped=${s.skipped} orphans=${s.orphans}`);
  for (const n of s.notes) console.log(`  · ${n}`);
}
console.log("\n---------------------------------------------------------------");
console.log(`TOTAL: rows=${totalRows} imported=${totalImported} skipped=${totalSkipped} orphans=${totalOrphans}`);
console.log(`deterministic checks: packages=${packages.size} apps=${apps.size} transactions=${transactions.length} creditRows=${credits.size}`);
const trxIds = transactions.filter((t) => t.trx_id !== null).map((t) => t.trx_id!);
console.log(`trx_id uniqueness: ${trxIds.length} attached, ${trxIds.length - new Set(trxIds).size} duplicates`);
console.log("================================================================");

// ── Apply or dry-run exit ─────────────────────────────────────────────────
if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply --db <path> to execute.");
  process.exit(0);
}

// Open through the server's own helper so migrations 001–009 run first and
// the connection gets the same WAL/FK pragmas the API uses.
const { openDb } = await import("../db.js");
const db = openDb(DB_PATH!);

const apply = db.transaction(() => {
  const insPkg = db.prepare(
    "INSERT INTO packages (id, package_code, name, sms_quota, price_bdt, validity_days, type, is_active, created_at, updated_at) " +
    "VALUES (@id, @package_code, @name, @sms_quota, @price_bdt, @validity_days, @type, @is_active, @created_at, @updated_at) " +
    "ON CONFLICT(package_code) DO NOTHING",
  );
  for (const p of packages.values()) insPkg.run(p);

  const insApp = db.prepare(
    "INSERT INTO apps (id, app_id, app_secret_hash, name, webhook_url, webhook_secret, webhook_secret_hash, " +
    "rate_max_per_phone, rate_window_sec, created_at, revoked_at) " +
    "VALUES (@id, @app_id, @app_secret_hash, @name, @webhook_url, @webhook_secret, @webhook_secret_hash, " +
    "@rate_max_per_phone, @rate_window_sec, @created_at, @revoked_at)",
  );
  for (const a of apps.values()) insApp.run(a);

  const insTx = db.prepare(
    "INSERT INTO credit_transactions (id, app_id, package_id, package_code, sms_quota, validity_days, " +
    "amount_bdt, package_type, trx_id, status, admin_notes, resolved_by, requested_at, resolved_at) " +
    "VALUES (@id, @app_id, @package_id, @package_code, @sms_quota, @validity_days, @amount_bdt, " +
    "@package_type, @trx_id, @status, @admin_notes, @resolved_by, @requested_at, @resolved_at) " +
    "ON CONFLICT(id) DO NOTHING",
  );
  for (const t of transactions) insTx.run(t);

  const insCr = db.prepare(
    "INSERT INTO app_credits (app_id, otp_sms_remaining, bulk_sms_remaining, otp_expires_at, bulk_expires_at, " +
    "last_transaction_id, purchased_at, updated_at) VALUES (@app_id, @otp_sms_remaining, @bulk_sms_remaining, " +
    "@otp_expires_at, @bulk_expires_at, @last_transaction_id, @purchased_at, @updated_at)",
  );
  for (const c of credits.values()) insCr.run(c);
});

try {
  apply();
} catch (err) {
  console.error("APPLY FAILED (transaction rolled back):", err instanceof Error ? err.message : err);
  db.close();
  process.exit(1);
}

const secretsFile = `${EXPORT_DIR}/../v4-import-app-secrets.json`;
writeFileSync(secretsFile, JSON.stringify(secretsOut, null, 2), { mode: 0o600 });
console.log(`\nAPPLIED. ${secretsOut.length} new app secret(s) written to ${secretsFile} (0600) — return-once, store safely.`);
console.log("If the secrets file is lost, rotate per app via POST /v5/admin/apps/:id/rotate-webhook-secret and re-provision.");
db.close();
