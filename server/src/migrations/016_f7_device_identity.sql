-- STAGE F7 (ISSUE-87): device phone-number identity + per-app device binding.
--
-- The engine previously never learned a gateway phone's number (label = Build.MODEL
-- only) and every enrolled device could pull the shared message queue. This adds:
--   1. devices.phone_number — E.164 identity, partial UNIQUE (one number fleet-wide).
--   2. devices.app_id       — nullable FK; NULL = operator-fleet device (current
--      behavior preserved), non-NULL = bound to exactly one app (claim isolation).
--   3. apps.device_enrollment_secret_hash — per-app enrollment secret, stored
--      SHA-256 like every other secret material; NULL until an app is created
--      (or re-secreted) after this migration — the rotate route mints one.
--
-- SQLite ALTER TABLE ADD COLUMN cannot express a partial index predicate, but the
-- partial WHERE on the index itself is supported — NULL phone numbers (unknown /
-- legacy rows) stay unlimited, non-NULL ones collide.

ALTER TABLE devices ADD COLUMN phone_number TEXT;
ALTER TABLE devices ADD COLUMN app_id TEXT REFERENCES apps(id);
ALTER TABLE apps ADD COLUMN device_enrollment_secret_hash TEXT;

CREATE UNIQUE INDEX idx_devices_phone_number
  ON devices (phone_number) WHERE phone_number IS NOT NULL;

-- Enrollment exchange looks the presented secret up by digest: index it.
CREATE INDEX idx_apps_device_enrollment_secret
  ON apps (device_enrollment_secret_hash);
