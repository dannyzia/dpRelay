-- M4 pass 2 — bulk campaigns (PLAN.md §10). Port of v4 bulk_campaigns +
-- recipients + bulk_usage audit + per-phone post-send cooldown, on SQLite.
--
-- 005/006 are applied in production restores and are NOT edited; additive
-- ALTERs live here.
--
-- Statuses mirror v4: campaign queued/sending/paused/completed/cancelled;
-- recipient pending/queued/sent/failed/cancelled.

CREATE TABLE bulk_campaigns (
  id            TEXT PRIMARY KEY,           -- UUID (public campaignId)
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  message       TEXT NOT NULL,
  charset       TEXT NOT NULL DEFAULT 'gsm' CHECK (charset IN ('gsm', 'ucs2')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sending', 'paused', 'completed', 'cancelled')),
  total_recipients INTEGER NOT NULL CHECK (total_recipients >= 0),
  sent_count    INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count  INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  queued_count  INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);

CREATE INDEX idx_bulk_campaigns_app
  ON bulk_campaigns (app_id, created_at DESC, id);
CREATE INDEX idx_bulk_campaigns_status
  ON bulk_campaigns (status, created_at ASC, id);

CREATE TABLE bulk_recipients (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES bulk_campaigns(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  idx           INTEGER NOT NULL CHECK (idx >= 0),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code    TEXT,
  error_message TEXT,
  pending_sms_id TEXT,                     -- linkage to the in-flight pending_sms row
  last_attempt_at INTEGER,
  UNIQUE (campaign_id, phone)
);

CREATE INDEX idx_bulk_recipients_campaign
  ON bulk_recipients (campaign_id, status, idx);
CREATE INDEX idx_bulk_recipients_pending_sms
  ON bulk_recipients (pending_sms_id);

-- v4 audit parity: one row per deducted recipient, phone stored as a hash
-- (no PII in the audit trail), idempotent per campaign+phone.
CREATE TABLE bulk_usage (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES bulk_campaigns(id) ON DELETE CASCADE,
  phone_hash  TEXT NOT NULL,
  deducted_at INTEGER NOT NULL,
  UNIQUE (campaign_id, phone_hash)
);

-- v4 parity: a phone that just confirmed a bulk delivery cannot receive
-- another bulk message for BULK_POST_SEND_COOLDOWN_SEC.
CREATE TABLE bulk_phone_cooldowns (
  phone      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Bulk completion webhooks ride the same audit table as OTP dispatches; the
-- campaign linkage is nullable so OTP rows keep NULL (005 is prod-applied).
ALTER TABLE webhook_deliveries ADD COLUMN campaign_id TEXT;
CREATE INDEX idx_webhook_deliveries_campaign
  ON webhook_deliveries (campaign_id);

-- v4 aggregateStats parity: current OTP/bulk counters for dashboards, one
-- upserted row (id=1) so the table never grows with tick cadence.
CREATE TABLE stats_current (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
