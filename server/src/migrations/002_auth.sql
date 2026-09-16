-- M1 auth schema (PLAN §5): users (Argon2 password hashing), devices (API keys),
-- and refresh-token sessions. Access tokens are stateless JWTs; the refresh_tokens
-- table is the server-side session store (hashed + expiring).
-- Clean-room design for dP Relay v5 — no schema copied from any external project.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- UUID (crypto.randomUUID)
  email         TEXT NOT NULL UNIQUE,      -- stored normalized (trim + lowercase)
  password_hash TEXT NOT NULL,             -- Argon2id encoded hash (PHC string format)
  created_at    INTEGER NOT NULL           -- unixepoch() seconds
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,           -- UUID (crypto.randomUUID)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,              -- human-readable device name
  api_key_hash TEXT NOT NULL UNIQUE,       -- SHA-256 hex of the device API key; raw key exists only at creation
  last_seen_at INTEGER,                    -- unixepoch() seconds; NULL until first heartbeat (watchdog input)
  revocable    INTEGER NOT NULL DEFAULT 1 CHECK (revocable IN (0, 1)),
  revoked_at   INTEGER,                    -- unixepoch() seconds; non-null = key rejected at the authz choke point
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,         -- SHA-256 hex; raw refresh token is never persisted
  expires_at INTEGER NOT NULL,             -- unixepoch() seconds
  revoked_at INTEGER,                      -- set on logout or refresh rotation
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
-- Watchdog scans for stale devices every tick; keep the range scan index-backed.
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
-- Future cleanup job (M2+) sweeps expired tokens; keep the expiry scan index-backed.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
