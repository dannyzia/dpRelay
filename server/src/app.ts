import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { openDb, type Db } from "./db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export interface AppOptions {
  dbPath?: string;
}

/**
 * Builds the Fastify application (routes registered, DB open + migrated).
 * Separated from index.ts so tests can inject a temporary database path.
 */
export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const config = loadConfig();
  const dbPath = opts.dbPath ?? config.dbPath;
  const db: Db = openDb(dbPath);

  const app = Fastify({ logger: { level: config.logLevel } });
  // Expose for route handlers and tests without module-level singletons
  app.decorate("db", db);

  app.get("/health", async () => {
    // DB ping: proves migrations ran and the file is writable this boot
    db.prepare("SELECT 1").get();
    return {
      status: "healthy",
      service: "dprelay-server",
      db: "ok",
      timestamp: Date.now(),
    };
  });

  app.get("/healthz", async () => ({ ok: true }));

  return app;
}
