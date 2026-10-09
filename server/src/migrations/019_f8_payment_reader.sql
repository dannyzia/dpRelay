-- STAGE F8 (ISSUE-90, hub event 1317): the dedicated Payment Reader APK and
-- the gateway phone both land in payment_sms, but the operator Payments panel
-- must tell which ingest path produced a row (the reader is the money phone's
-- single-purpose app; the gateway is the OTP device). Additive only — applied
-- migrations are never edited. Rows written before this migration predate the
-- reader and are gateway rows; the DEFAULT records exactly that.
ALTER TABLE payment_sms ADD COLUMN source TEXT NOT NULL DEFAULT 'gateway'
  CHECK (source IN ('gateway', 'reader'));
