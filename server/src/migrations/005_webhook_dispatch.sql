-- M3 tail: signed webhook dispatch (Rhizome ISSUE-7 remaining item). When the
-- gateway phone reports delivery results, a result belonging to an otp_session
-- triggers a signed webhook to the owning app's webhook_url.
--
-- Why a plaintext secret (not just the hash): the SERVER signs deliveries with
-- HMAC-SHA256, so it must hold the raw key material — webhook_secret_hash
-- alone can only verify, never sign. Rotating the secret means writing a new
-- value here; the hash column is updated with it to keep verifiers in sync.

ALTER TABLE apps ADD COLUMN webhook_secret TEXT;

CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  session_id   TEXT REFERENCES otp_sessions(id) ON DELETE SET NULL,
  app_id       TEXT REFERENCES apps(id) ON DELETE SET NULL,
  webhook_url  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'delivered', 'failed')),
  attempt      INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  attempts_max INTEGER NOT NULL DEFAULT 3 CHECK (attempts_max >= 1),
  response_code INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX idx_webhook_deliveries_session ON webhook_deliveries (session_id, created_at);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries (status, created_at);
