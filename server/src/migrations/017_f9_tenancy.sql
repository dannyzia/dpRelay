-- STAGE F9 (ISSUE-88): tenancy — User → many Companies (each 1:1 with one
-- App + its gateway number via F7) and a USER-level credit wallet.
--
--   1. companies          — owner_user_id → users; disabled = withheld (its
--                           app's sends are blocked at the requireApp choke
--                           point, mirroring owner withhold semantics).
--   2. apps.company_id    — nullable FK (NULL = operator-provisioned legacy,
--                           operator plane untouched). A PARTIAL UNIQUE index
--                           makes "one app per company" a database invariant,
--                           not an application check (ISSUE-77 spirit).
--   3. user_credits       — the wallet; same shape as app_credits (incl. the
--                           ISSUE-84 trial_* snapshot the ledger reads, and
--                           last_transaction_id/purchased_at bookkeeping).
--                           PK(user_id) makes one wallet per user a database
--                           invariant — the trial once-per-user rule leans on
--                           it (N companies must not yield N×20 free SMS).
--   4. credit_transactions gains user_id (nullable): wallet purchases made via
--      the session-authenticated /v5/billing/credits/request variant are
--      attributed to the USER, not an app. The table is rebuilt (SQLite cannot
--      relax a NOT NULL column in place); the new CHECK makes
--      "app-attributed XOR user-attributed" a database invariant. Existing
--      rows copy over app-attributed with user_id NULL — zero data change.
--
-- Wallet rule (exact, dual-path): an app whose chain resolves app → company →
-- owner deducts from user_credits; an app with no company (operator-legacy)
-- deducts from app_credits as today. Applied by services/wallet.ts at every
-- enforcement site (otp pre-check AND in-transaction guard; bulk
-- reserve/deduct/refund; award on approve).
--
-- Applied migrations are never edited (schema_migrations tracks by filename).

CREATE TABLE companies (
  id            TEXT PRIMARY KEY,           -- UUID (internal)
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,           -- unixepoch() seconds
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);
CREATE INDEX idx_companies_owner_user_id ON companies(owner_user_id);

ALTER TABLE apps ADD COLUMN company_id TEXT REFERENCES companies(id);
CREATE UNIQUE INDEX idx_apps_company_id
  ON apps (company_id) WHERE company_id IS NOT NULL;

CREATE TABLE user_credits (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  otp_sms_remaining   INTEGER NOT NULL DEFAULT 0 CHECK (otp_sms_remaining >= 0),
  bulk_sms_remaining  INTEGER NOT NULL DEFAULT 0 CHECK (bulk_sms_remaining >= 0),
  otp_expires_at      INTEGER,
  bulk_expires_at     INTEGER,
  -- trial_* snapshot (ISSUE-84 parity): the ledger's kind=trial rows read
  -- these — the balance itself is spent away and proves nothing.
  trial_sms_granted   INTEGER,
  trial_granted_at    INTEGER,
  last_transaction_id TEXT,
  purchased_at        INTEGER,
  updated_at          INTEGER NOT NULL
);

-- credit_transactions: rebuild with user_id + XOR attribution CHECK.
CREATE TABLE credit_transactions_new (
  id            TEXT PRIMARY KEY,           -- UUID (public transactionId)
  app_id        TEXT REFERENCES apps(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL REFERENCES packages(id),
  package_code  TEXT NOT NULL,              -- denormalized snapshot (006 note 1)
  sms_quota     INTEGER NOT NULL CHECK (sms_quota >= 1),
  validity_days INTEGER NOT NULL CHECK (validity_days >= 1),
  amount_bdt    INTEGER NOT NULL CHECK (amount_bdt >= 0),
  package_type  TEXT NOT NULL DEFAULT 'otp' CHECK (package_type IN ('otp', 'bulk', 'both')),
  trx_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_notes   TEXT,
  resolved_by   TEXT,
  requested_at  INTEGER NOT NULL,
  resolved_at   INTEGER,
  -- Exactly one attribution: a purchase belongs to an app OR to a user
  -- wallet, never both, never neither.
  CHECK ((app_id IS NOT NULL) + (user_id IS NOT NULL) = 1)
);

INSERT INTO credit_transactions_new (
  id, app_id, user_id, package_id, package_code, sms_quota, validity_days,
  amount_bdt, package_type, trx_id, status, admin_notes, resolved_by,
  requested_at, resolved_at
)
SELECT
  id, app_id, NULL, package_id, package_code, sms_quota, validity_days,
  amount_bdt, package_type, trx_id, status, admin_notes, resolved_by,
  requested_at, resolved_at
FROM credit_transactions;

DROP TABLE credit_transactions;
ALTER TABLE credit_transactions_new RENAME TO credit_transactions;

-- Recreate the 006 indexes (dropped with the table) + one for wallet history.
CREATE UNIQUE INDEX idx_credit_transactions_trx_id
  ON credit_transactions (trx_id)
  WHERE trx_id IS NOT NULL;
CREATE INDEX idx_credit_transactions_app
  ON credit_transactions (app_id, requested_at DESC);
CREATE INDEX idx_credit_transactions_status
  ON credit_transactions (status, requested_at DESC);
CREATE INDEX idx_credit_transactions_user
  ON credit_transactions (user_id, requested_at DESC);
