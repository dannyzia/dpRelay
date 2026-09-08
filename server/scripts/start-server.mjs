// Pre-start validation: resolve config with env vars, verify required fields, then exec Litestream.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "litestream.yml");

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const raw = readFileSync(configPath, "utf8");

// Manual env var substitution (Litestream does this too, but we verify first)
const substituted = raw.replace(/\$\{([^}]+)\}/g, (_, key) => {
  const val = process.env[key];
  if (val === undefined) {
    console.warn(`Env var ${key} not set — Litestream will see empty value`);
    return "";
  }
  return val;
});

// Basic YAML parse (just enough to verify required fields)
const lines = substituted.split("\n");
let hasDbPath = false;
let hasReplica = false;
let inReplica = false;

for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed.startsWith("path:")) hasDbPath = true;
  if (trimmed.startsWith("replicas:")) inReplica = true;
  if (inReplica && trimmed.startsWith("type:") && trimmed.includes("s3")) hasReplica = true;
}

if (!hasDbPath) {
  console.error("Config validation FAILED: 'path' (database path) not found");
  process.exit(1);
}
if (!hasReplica) {
  console.error("Config validation FAILED: no S3 replica found");
  process.exit(1);
}

console.log("Config validation: OK (db path + S3 replica present)");
console.log("Starting Litestream...");

// Litestream v0.3.x CLI: global -config flag must come AFTER the subcommand,
// and restore takes the DB path as a positional arg matched against the config.
//   litestream restore  -config <file> -if-db-not-exists <db_path>
//   litestream replicate -config <file> -exec "<command>"
const litestreamPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "litestream");
const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(litestreamPath, [
  "restore",
  "-config", "litestream.yml",
  "-if-db-not-exists",
  "./data/dprelay.db",
], { stdio: "inherit", cwd: serverRoot });

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`Restore failed with code ${code}`);
    process.exit(code);
  }
  // Restore succeeded, start replication + server
  const replicate = spawn(litestreamPath, [
    "replicate",
    "-config", "litestream.yml",
    "-exec", "node dist/index.js",
  ], { stdio: "inherit", cwd: serverRoot });
  replicate.on("close", (c) => process.exit(c));
});

child.on("error", (err) => {
  console.error("Failed to spawn Litestream:", err);
  process.exit(1);
});