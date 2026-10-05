-- Durable job-runner state that previously lived only in the process.
--
-- Why this table exists: the alert-sink failure counters and the watchdog's
-- stale-alert dedupe were a module Map and two module variables. Every redeploy
-- wiped them, which meant a sink that had been failing for an hour reported
-- itself healthy the instant a new build booted — /health/alerts returned 200,
-- and an uptime monitor recorded a green blip over a live outage.
--
-- Generic key/value rather than typed columns: the two state sets have different
-- shapes and a third counter should not require another migration. Values are
-- JSON and rows are written only on state TRANSITIONS, so this stays a handful
-- of rows that are rewritten rarely.
--
-- `lastError` is deliberately never stored here. It carries whatever the failing
-- transport put in it — a webhook URL, a response body — and the alert detail
-- already lives in the access-controlled log stream. Counters and a timestamp
-- are all that the health endpoint needs.
CREATE TABLE IF NOT EXISTS job_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
