/**
 * Central config for the dP Relay v5 server.
 * All environment-specific values come from env vars — nothing hardcoded here.
 */
export interface Config {
  port: number;
  host: string;
  logLevel: string;
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    dbPath: env.DB_PATH ?? "./data/dprelay.db",
  };
}
