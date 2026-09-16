-- M3 OTP plane (PLAN.md §7): the app registry (v4 `registered_apps` parity —
-- appId + hashed secret + per-app webhook + per-phone OTP rate limits) and the
-- OTP session store (v4 `otp_requests` parity — hashed code, per-OTP salt,
-- attempt counter, lockout, expiry).

CREATE TABLE apps (
  id                  TEXT PRIMARY KEY,        -- UUID (internal FK target)
  app_id              TEXT NOT NULL UNIQUE,    -- public identifier (X-App-Id)
  app_secret_hash     TEXT NOT NULL,           -- SHA-256 hex of appSecret
  name                TEXT NOT NULL,
  webhook_url         TEXT,                    -- OTP status delivery target (M3 inversion)
  webhook_secret_hash TEXT,                    -- SHA-256 hex; HMAC-SHA256 signing key
  rate_max_per_phone  INTEGER NOT NULL DEFAULT 3 CHECK (rate_max_per_phone >= 1),
  rate_window_sec     INTEGER NOT NULL DEFAULT 3600 CHECK (rate_window_sec >= 1),
  revoked_at          INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE TABLE otp_sessions (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,                    -- strict E.164 (+countrynumber)
  otp_hash    TEXT NOT NULL,                    -- sha256(salt || otp); per-OTP salt
  salt        TEXT NOT NULL,                    -- never reused across sessions
  attempts    INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,                         -- non-NULL while lockout is active
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'verified', 'expired')),
  message_id  TEXT REFERENCES pending_sms(id),  -- outbound SMS produced by send
  created_at  INTEGER NOT NULL,
  verified_at INTEGER
);

-- Verify/status target the newest pending session per (app, phone).
CREATE INDEX idx_otp_sessions_lookup
  ON otp_sessions (app_id, phone, status, created_at DESC);
-- Expiry sweep + expiry filtering in verify.
CREATE INDEX idx_otp_sessions_expiry ON otp_sessions (expires_at);
