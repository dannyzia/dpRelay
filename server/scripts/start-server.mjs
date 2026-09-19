// Pre-start: validate litestream.yml + env vars, restore-on-boot, then replicate+serve.
// Render free tier has an ephemeral disk — every boot restores the DB from R2 (plan R2 constraint,
// SETUP-R2.md §5.2). LITESTREAM_ENABLED=false starts the API directly (local dev only).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "litestream.yml");
const litestreamPath = join(root, "bin", "litestream");
const dbPath = "./data/dprelay.db";

// Spawn the downloaded binary by absolute path: Render's Node image has no
// `litestream` on PATH (and the binary lives in server/bin), so a bare spawn
// fails with ENOENT and kills the boot before the API ever starts.

function fail(msg) {
  console.error(`STARTUP FAILED: ${msg}`);
  process.exit(1);
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { stdio: "inherit", cwd: root });
    child.on("close", (code) => resolve(code));
    child.on("error", (err) => {
      console.error("spawn failed:", err);
      resolve(1);
    });
  });
}

// Durability-first default: when unset, assume Litestream IS configured (R2) and
// fail fast if it is not — never silently boot without restore/replicate in prod.
// Local dev opts out explicitly via LITESTREAM_ENABLED=false (see .env.example).
const litestreamEnabled =
  (process.env.LITESTREAM_ENABLED ?? "true").trim().toLowerCase() !== "false";

if (!litestreamEnabled) {
  console.log("LITESTREAM_ENABLED=false — starting API directly (no restore/replicate)");
  const code = await run(["node", "dist/index.js"]);
  process.exit(code ?? 0);
}

if (!existsSync(configPath)) fail(`config not found: ${configPath}`);
if (!existsSync(litestreamPath)) fail(`litestream binary not found: ${litestreamPath}`);

const raw = readFileSync(configPath, "utf8");
// Strip full-line comments BEFORE scanning — the header comment mentions ${VAR} literally.
const content = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

// 1. Every ${KEY} in the config must resolve to a non-empty env var.
const referenced = [...content.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
const missing = referenced.filter((k) => !process.env[k] || process.env[k].trim() === "");
if (missing.length > 0) {
  fail(`missing env var(s): ${missing.join(", ")} — set them in Render → Environment`);
}
console.log(`Config validation: all ${referenced.length} env vars present`);

// 2. Structural checks (list-item tolerant: "- path: ..." must match).
if (!/^\s*-?\s*path:\s*\S+/m.test(content)) fail("no database 'path:' found in config");
if (!/type:\s*s3/m.test(content)) fail("no s3 replica found in config");
console.log("Config validation: OK (db path + s3 replica)");

// 3. Restore-on-boot (R2 constraint: ephemeral disk — restore BEFORE the API starts).
// On the very first boot the R2 bucket is empty, so restore has nothing to pull —
// treat that as non-fatal (fresh DB via migrations) and let replicate surface any
// real credential/config problem.const restoreCode = await run([
  litestreamPath,
  "restore",
  "-config",
  "litestream.yml",
  "-if-db-not-exists",
  dbPath,
]);

if (restoreCode !== 0) {
  console.warn(
    `restore exited ${restoreCode} — expected on first boot (empty bucket). ` +
      "Continuing with a fresh database; replicate will start the first generation.",
  );
} else {
  console.log("restore: ok");
}

// 4. Replicate + run the API server under litestream supervision.const replicateCode = await run([
  litestreamPath,
  "replicate",
  "-config",
  "litestream.yml",
  "-exec",
  "node dist/index.js",
]);
process.exit(replicateCode ?? 0);
