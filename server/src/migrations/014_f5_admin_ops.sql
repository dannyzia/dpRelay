-- STAGE F5 (ISSUE-83, hub event 1213): admin operations expansion.
-- payment_match_config — the payment-SMS auto-attach proposal parameters
-- (amount tolerance + time window) are OPERATOR-TUNABLE config, explicitly
-- NOT hardcoded in matching code. Singleton row (id=1), seeded with the
-- placeholder defaults flagged on the hub (STEP 7 flag 1); the operator
-- tunes them from #/operator → Payments.
-- Applied migrations are never edited (schema_migrations tracks by filename).

CREATE TABLE IF NOT EXISTS payment_match_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
  tolerance_bdt INTEGER NOT NULL CHECK (tolerance_bdt >= 0),
  window_sec    INTEGER NOT NULL CHECK (window_sec >= 0),
  updated_at    INTEGER NOT NULL
);

INSERT INTO payment_match_config (id, tolerance_bdt, window_sec, updated_at)
  VALUES (1, 100, 604800, unixepoch());
