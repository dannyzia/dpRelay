-- ISSUE-38 follow-on: silent, self-healing quarantine for devices that never
-- heartbeated.
--
-- Deliberately NOT revoked_at. Quarantine suppresses the device from the stale
-- set and from alerting, but the device keeps working and a single heartbeat
-- clears it automatically. That distinction is the whole point: there is no
-- device unrevoke route (apps have /unrevoke, devices do not), so revocation
-- is a one-way door and must stay a deliberate operator decision. A device that
-- has merely never come online should be quiet, not dead.
--
-- 001–009 are applied in production restores and are NOT edited; additive
-- changes live here.
ALTER TABLE devices ADD COLUMN quarantined_at INTEGER;

-- The watchdog sweeps quarantined devices every tick; without an index that
-- becomes a full scan on every cron run.
CREATE INDEX IF NOT EXISTS idx_devices_quarantined ON devices(quarantined_at);
