-- M4 pass 1 — billing plane (PLAN.md §10, Addendum #1): credit packages,
-- credit purchase transactions, and per-app credit balances.
--
-- Port of v4 Firestore (packages / transactions / app_credits) with two
-- structural upgrades the v4 code could not enforce:
-- 1. Package details are SNAPSHOTTED onto the transaction at request time
--    (sms_quota, validity_days, amount_bdt, package_type). v4 read package
--    type at approve time, so an operator edit between request and approve
--    silently changed what the customer was awarded.
-- 2. Single-award guarantee (Addendum #1): a PARTIAL UNIQUE INDEX on
--    credit_transactions.trx_id (non-null only — 'pending' rows with no TrxID
--    yet must coexist) makes one TrxID → one transaction a database invariant,
--    not an application check. The admin approve path additionally re-checks
--    pending state inside the award transaction.

CREATE TABLE packages (
  id            TEXT PRIMARY KEY,           -- UUID (internal)
  package_code  TEXT NOT NULL UNIQUE,       -- stable public identifier (upsert key)
  name          TEXT NOT NULL,
  sms_quota     INTEGER NOT NULL CHECK (sms_quota >= 1),
  price_bdt     INTEGER NOT NULL CHECK (price_bdt >= 0),
  validity_days INTEGER NOT NULL CHECK (validity_days >= 1),
  type          TEXT NOT NULL DEFAULT 'otp' CHECK (type IN ('otp', 'bulk', 'both')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE credit_transactions (
  id            TEXT PRIMARY KEY,           -- UUID (public transactionId)
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL REFERENCES packages(id),
  package_code  TEXT NOT NULL,              -- denormalized snapshot: history must
                                              -- survive package upserts/deletions
  -- Snapshot of the package at request time (see note 2 above).
  sms_quota     INTEGER NOT NULL CHECK (sms_quota >= 1),
  validity_days INTEGER NOT NULL CHECK (validity_days >= 1),
  amount_bdt    INTEGER NOT NULL CHECK (amount_bdt >= 0),
  package_type  TEXT NOT NULL DEFAULT 'otp' CHECK (package_type IN ('otp', 'bulk', 'both')),
  -- bKash TrxID as typed by the customer; unique once present (Addendum #1).
  trx_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_notes   TEXT,
  resolved_by   TEXT,                       -- operator identifier on approve/reject
  requested_at  INTEGER NOT NULL,
  resolved_at   INTEGER
);

-- Addendum #1: one TrxID can ever be attached to one transaction. Partial
-- index — NULL trx_id (not yet submitted) rows are exempt.
CREATE UNIQUE INDEX idx_credit_transactions_trx_id
  ON credit_transactions (trx_id)
  WHERE trx_id IS NOT NULL;

CREATE INDEX idx_credit_transactions_app
  ON credit_transactions (app_id, requested_at DESC);
CREATE INDEX idx_credit_transactions_status
  ON credit_transactions (status, requested_at DESC);

CREATE TABLE app_credits (
  app_id               TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  otp_sms_remaining    INTEGER NOT NULL DEFAULT 0 CHECK (otp_sms_remaining >= 0),
  bulk_sms_remaining   INTEGER NOT NULL DEFAULT 0 CHECK (bulk_sms_remaining >= 0),
  otp_expires_at       INTEGER,
  bulk_expires_at      INTEGER,
  last_transaction_id  TEXT,
  purchased_at         INTEGER,
  updated_at           INTEGER NOT NULL
);
