-- STAGE F3 amendment (ISSUE-82, hub events 1209-1212): operator-configured
-- SMTP + email verification + self-service password reset.
-- SMTP config lives in the DB (never env vars — owner decision): the password
-- column stores AES-256-GCM ciphertext only (key derived from the server
-- secret at runtime); no route ever returns it.
-- Applied migrations are never edited (schema_migrations tracks by filename).

CREATE TABLE IF NOT EXISTS mail_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username           TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,                        -- AES-256-GCM, v1-prefixed
  from_address       TEXT NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_email_tokens (
  id         TEXT PRIMARY KEY,                 -- UUID
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash TEXT NOT NULL UNIQUE,             -- SHA-256 hex; raw token exists only in the emailed link
  expires_at INTEGER NOT NULL,                 -- unixepoch() seconds
  used_at    INTEGER,                          -- single-use: set on consumption
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_email_tokens_user ON user_email_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_email_tokens_expires ON user_email_tokens(expires_at);

-- Soft verification (flagged): presence of a timestamp = verified; login is
-- never gated on it (additive-hybrid contract preservation).
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
