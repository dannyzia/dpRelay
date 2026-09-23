-- M4 pass 3 remainder — admin app plane (PLAN.md §10). Operator-gated
-- registry management on the 004 apps table.
--
-- 001–008 are applied in production restores and are NOT edited; additive
-- changes live here.
--
-- Tracks when a configured webhook_secret was last replaced so clients can
-- distinguish "rotation happened, re-run your signature verification" from a
-- first-time secret mint (which never had a previous value to rotate).
ALTER TABLE apps ADD COLUMN webhook_rotated_at INTEGER;
