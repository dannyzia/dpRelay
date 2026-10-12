-- ISSUE-96: Unlimited BYOD phone plans. An app subscribes to a tier that
-- covers gateway orchestration for CUSTOMER-OWNED Android phones bound to it
-- (devices.app_id, F7); dedicated BD-pool sends (operator fleet) always keep
-- paying BDT credits regardless of plan state.
--
--   1. app_subscriptions — one purchase request or active subscription per app
--      (partial UNIQUE indexes on the per-app pending/active row make "at most
--      one of each" a database invariant, not an application check).
--      max_devices/price_usd are request-time snapshots (same money principle
--      as credit_transactions' snapshot columns); the catalog itself lives in
--      services/plans.ts.
--   2. pending_sms.unlimited_pass — stamped at SEND time: 1 = this message was
--      released under an active plan's BYOD free-pass, so it may only ever be
--      claimed by the owning app's own bound device, never the BD operator
--      fleet (outstanding-fetch clause in routes/device.ts). 0 = paid message,
--      fleet-eligible as before.
--   3. bulk_campaigns.unlimited_pass — the campaign-level snapshot of the same
--      decision (creation time); cancel refunds and retry re-deductions read it
--      so money never appears or disappears based on later plan-state changes.
--
-- Applied migrations are never edited (schema_migrations tracks by filename).

CREATE TABLE app_subscriptions (
  id           TEXT PRIMARY KEY,            -- UUID (subscriptionId)
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  plan_code    TEXT NOT NULL
               CHECK (plan_code IN ('unlimited_1', 'unlimited_5', 'unlimited_20')),
  max_devices  INTEGER NOT NULL CHECK (max_devices >= 1),
  price_usd    INTEGER NOT NULL CHECK (price_usd >= 0), -- whole USD at request time
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'active', 'rejected', 'superseded')),
  trx_id       TEXT,                       -- bKash TrxID (10 alnum), attached by submit-trx
  admin_notes  TEXT,
  requested_at INTEGER NOT NULL,           -- unixepoch() seconds
  resolved_at  INTEGER,
  starts_at    INTEGER,
  expires_at   INTEGER                     -- active only; NULL while pending/rejected
);

-- At most ONE pending purchase and ONE active subscription per app.
CREATE UNIQUE INDEX idx_app_subscriptions_pending
  ON app_subscriptions (app_id) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_app_subscriptions_active
  ON app_subscriptions (app_id) WHERE status = 'active';
-- One TrxID can fund exactly one subscription, ever (same rule as credits).
CREATE UNIQUE INDEX idx_app_subscriptions_trx
  ON app_subscriptions (trx_id) WHERE trx_id IS NOT NULL;

-- Send-time audit of the free-pass decision (operator reports + fleet clause).
ALTER TABLE pending_sms ADD COLUMN unlimited_pass INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bulk_campaigns ADD COLUMN unlimited_pass INTEGER NOT NULL DEFAULT 0;
