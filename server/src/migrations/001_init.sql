-- M1 baseline schema: settings (kill switch etc.) only.
-- Business tables (otp_sessions, pending_sms, apps, credits, campaigns...) arrive in M2-M4.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings(key, value, updated_at)
VALUES ('kill_switch', 'false', unixepoch());
