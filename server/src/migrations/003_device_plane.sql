-- M2 device plane (PLAN.md §7): outbound queue the phone pulls from, payment-SMS
-- ingest for bKash/Nagad reconciliation, FCM token storage, and nullable device
-- ownership for enrollment.
--
-- devices rebuild: user_id becomes nullable. M2 enrollment
-- (POST /v5/device/enroll) provisions the gateway phone WITHOUT a user account
-- (ADR-016 enrollment-secret exchange), which 002's NOT NULL forbids. SQLite
-- cannot alter a column constraint, so the table is rebuilt (copy → drop →
-- rename). fcm_token is added in the same rebuild rather than a separate ALTER.
-- 002 is already applied on production restores (Litestream), so it must not be
-- edited — the rebuild lives here in 003.
--
-- pending_sms mirrors the v4 RTDB shape (appId/to/message/status/createdAt) so
-- the M3 OTP producer ports 1:1, plus claim columns for at-least-once delivery:
-- a row is handed out as 'claimed' and re-offered to another fetch if the phone
-- never reports a result within the requeue window (OUTSTANDING_REQUEUE_SEC).

CREATE TABLE devices_new (
  id           TEXT PRIMARY KEY,           -- UUID (crypto.randomUUID)
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL for phone-enrolled devices
  label        TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,       -- SHA-256 hex; raw key exists only at creation
  last_seen_at INTEGER,
  revocable    INTEGER NOT NULL DEFAULT 1 CHECK (revocable IN (0, 1)),
  revoked_at   INTEGER,
  fcm_token    TEXT,                       -- registered via POST /v5/device/fcm-token
  created_at   INTEGER NOT NULL
);

INSERT INTO devices_new (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at)
  SELECT id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at FROM devices;

DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

-- The originals died with the old table; watchdog + user-scoped queries need them.
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);

CREATE TABLE pending_sms (
  id            TEXT PRIMARY KEY,
  app_id        TEXT,
  to_addr       TEXT NOT NULL,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
  error         TEXT,
  claimed_at    INTEGER,
  claimed_by    TEXT REFERENCES devices(id),
  claimed_count INTEGER NOT NULL DEFAULT 0,
  result_at     INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_pending_sms_status_created
  ON pending_sms (status, created_at);

CREATE TABLE payment_sms (
  id           TEXT PRIMARY KEY,
  device_id    TEXT REFERENCES devices(id),
  sender       TEXT NOT NULL,
  provider     TEXT NOT NULL CHECK (provider IN ('bkash', 'nagad')),
  -- bKash/Nagad transaction IDs are unique; a duplicate POST (phone retry) is
  -- an idempotent no-op, not a second reconciliation entry.
  txn_id       TEXT NOT NULL UNIQUE,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa >= 0),
  received_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_payment_sms_received ON payment_sms (received_at);
