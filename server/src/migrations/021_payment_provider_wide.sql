-- ISSUE-98 (confirmed schema change): the AI extractor (AC6) classifies
-- bkash, nagad, rocket, upay and bank confirmations, but payment_sms.provider
-- CHECKs only ('bkash', 'nagad') — a legit non-bKash/Nagad row would violate
-- it. SQLite cannot ALTER a CHECK, so rebuild the table exactly (all columns
-- from 003 + 015 + 019 preserved, same UNIQUE txn_id, same index). The
-- auto-match rule is provider-agnostic (amount + window), so nothing else
-- changes. Runner executes this inside its own transaction — no BEGIN here.
CREATE TABLE payment_sms_wide (
  id           TEXT PRIMARY KEY,
  device_id    TEXT REFERENCES devices(id),
  sender       TEXT NOT NULL,
  provider     TEXT NOT NULL CHECK (provider IN ('bkash', 'nagad', 'rocket', 'upay', 'bank')),
  -- bKash/Nagad transaction IDs are unique; a duplicate POST (phone retry) is
  -- an idempotent no-op, not a second reconciliation entry.
  txn_id       TEXT NOT NULL UNIQUE,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa >= 0),
  received_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  review_state TEXT CHECK (review_state IS NULL OR review_state IN ('approved', 'rejected')),
  review_reason TEXT,
  reviewed_at  INTEGER,
  source       TEXT NOT NULL DEFAULT 'gateway' CHECK (source IN ('gateway', 'reader'))
);

INSERT INTO payment_sms_wide (id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at, review_state, review_reason, reviewed_at, source)
  SELECT id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at, review_state, review_reason, reviewed_at, source
  FROM payment_sms;

DROP TABLE payment_sms;
ALTER TABLE payment_sms_wide RENAME TO payment_sms;

CREATE INDEX idx_payment_sms_received ON payment_sms (received_at);
