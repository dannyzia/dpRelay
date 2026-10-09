-- STAGE F3 (ISSUE-81): real customer auth for the web-v5 dashboard.
-- users already exists (002_auth.sql: normalized-unique email + Argon2 hash),
-- so this migration only adds what the customer plane needs on top:
--   1. users.disabled        — login + session resolution reject disabled rows
--   2. user_sessions         — server-side store for the HttpOnly dashboard
--                              cookie (hashed tokens; raw value never persisted)
--   3. apps.owner_user_id    — NULL keeps operator-provisioned apps exactly as
--                              they are today (Haven et al. untouched); only the
--                              self-serve register/link routes ever set it
-- Applied migrations are never edited (schema_migrations tracks by filename).

ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_sessions (
  id         TEXT PRIMARY KEY,          -- UUID (crypto.randomUUID)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 hex; raw token exists only in the cookie
  expires_at INTEGER NOT NULL,          -- unixepoch() seconds
  created_at INTEGER NOT NULL           -- unixepoch() seconds
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- Nullable FK: SQLite requires NULL default for an added FK column, which is
-- exactly the semantics we want (NULL = operator-provisioned). Existing rows
-- are untouched by the ALTER.
ALTER TABLE apps ADD COLUMN owner_user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_apps_owner_user_id ON apps(owner_user_id);
