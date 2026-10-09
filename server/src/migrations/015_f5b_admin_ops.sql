-- STAGE F5b (ISSUE-84, prescriptive spec hub event 1266): the delta PR #67's
-- original build missed. Additive only — predecessors are applied (003/006/
-- 012) or branch-only (014); applied migrations are never edited.
--
-- 1. payment_sms review state — approve/reject is a human action on a payment
--    ROW (spec: reject requires a stored reason shown on the row). NULL =
--    open; 'approve'/'reject' terminal. The reason lives beside the state so
--    the panel can render it as a tooltip on the rejected chip.
-- 2. users withhold reason — disable REQUIRES a reason (spec: badge + reason
--    tooltip on the withheld row); disabled_at timestamps it.
-- 3. admin_audit — every withhold action writes operator + timestamp +
--    reason (spec: "every action writes to the audit trail").
-- 4. app_credits trial snapshot — the ledger needs kind=trial rows with a
--    real qty + timestamp; the grant was previously unrecoverable after the
--    first balance change. Written at the two grant sites going forward;
--    rows created before this migration keep NULL (history is genuinely
--    unrecoverable — the ledger shows no fabricated trial rows for them).

ALTER TABLE payment_sms ADD COLUMN review_state TEXT
  CHECK (review_state IS NULL OR review_state IN ('approved', 'rejected'));
ALTER TABLE payment_sms ADD COLUMN review_reason TEXT;
ALTER TABLE payment_sms ADD COLUMN reviewed_at INTEGER;

ALTER TABLE users ADD COLUMN disabled_reason TEXT;
ALTER TABLE users ADD COLUMN disabled_at INTEGER;

CREATE TABLE IF NOT EXISTS admin_audit (
  id           TEXT PRIMARY KEY,
  actor        TEXT NOT NULL DEFAULT 'operator',
  action       TEXT NOT NULL,               -- 'user.withhold' | 'user.lift'
  subject_type TEXT NOT NULL,               -- 'user'
  subject_id   TEXT NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit (created_at DESC, id DESC);

ALTER TABLE app_credits ADD COLUMN trial_sms_granted INTEGER;
ALTER TABLE app_credits ADD COLUMN trial_granted_at INTEGER;
