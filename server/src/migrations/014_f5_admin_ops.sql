-- STAGE F5 (ISSUE-83 → ISSUE-84 prescriptive spec, hub event 1266): admin
-- operations config. Payment SMS auto-match parameters are OPERATOR-TUNABLE
-- config rows, explicitly NOT hardcoded in matching code.
--
-- AMENDED in place (branch-only: this migration never applied to any durable
-- DB — ISSUE-84 AC allows it): the original payment_match_config singleton
-- (100 BDT / 604800 s seeds) is superseded by the spec's key-value rows with
-- defaults payment_match_window_min = 30 and payment_match_tolerance_bdt = 0,
-- editable through GET/PUT /v5/admin/config/:key (whitelist of two keys).
-- Applied migrations are never edited (schema_migrations tracks by filename).

CREATE TABLE IF NOT EXISTS admin_config (
  key        TEXT PRIMARY KEY,             -- whitelisted key (routes/admin-config.ts)
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO admin_config (key, value, updated_at) VALUES
  ('payment_match_window_min', 30, unixepoch()),
  ('payment_match_tolerance_bdt', 0, unixepoch());
