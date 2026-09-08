import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export type Db = Database.Database;

/**
 * Opens the SQLite database with WAL + foreign keys enabled and applies
 * any not-yet-applied migrations from src/migrations (sorted by filename).
 * Each migration runs in a transaction; applied ones are tracked in
 * schema_migrations so restarts are idempotent (required on Render where
 * every boot starts from an empty disk restored by Litestream).
 */
export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    (
      db
        .prepare("SELECT name FROM schema_migrations")
        .all() as { name: string }[]
    ).map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlPath = join(MIGRATIONS_DIR, file);
    const apply = db.transaction(() => {
      db.exec(readFileSync(sqlPath, "utf8"));
      db.prepare(
        "INSERT INTO schema_migrations(name, applied_at) VALUES (?, unixepoch())",
      ).run(file);
    });
    apply();
  }
}
