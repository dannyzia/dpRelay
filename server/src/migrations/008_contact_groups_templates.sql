-- M4 pass 3 — contact groups + message templates (PLAN.md §10), per-app scoped.
--
-- 001–007 are applied in production restores and are NOT edited; additive
-- changes live here.
--
-- v4 parity (Firestore contactGroups + messageTemplates collections, written
-- directly by the web client — v4 had no server CRUD): group = {uid, name,
-- phoneCount} + phones subcollection; template = {name, body}. v5 makes both
-- first-class per-app entities with real REST CRUD. uid→app_id is the v4→v5
-- re-scope (same as billing/campaigns: the app credential is the tenant).
--
-- Timestamps are unixepoch seconds (house convention).

CREATE TABLE contact_groups (
  id            TEXT PRIMARY KEY,           -- UUID (public groupId)
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  phone_count   INTEGER NOT NULL DEFAULT 0 CHECK (phone_count >= 0),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (app_id, name)
);

CREATE INDEX idx_contact_groups_app
  ON contact_groups (app_id, created_at DESC, id);

CREATE TABLE contact_group_phones (
  group_id      TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  UNIQUE (group_id, phone)
);

CREATE INDEX idx_contact_group_phones_group
  ON contact_group_phones (group_id, phone);

CREATE TABLE message_templates (
  id            TEXT PRIMARY KEY,           -- UUID (public templateId)
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (app_id, name)
);

CREATE INDEX idx_message_templates_app
  ON message_templates (app_id, created_at DESC, id);

-- Campaign create snapshots its source: sourceType=contactGroups records which
-- groups fed the recipients. Recipients themselves are materialized rows at
-- create time, so later group edits never mutate a running campaign.
ALTER TABLE bulk_campaigns ADD COLUMN source_type TEXT NOT NULL DEFAULT 'csv'
  CHECK (source_type IN ('csv', 'contactGroups'));
ALTER TABLE bulk_campaigns ADD COLUMN source_group_ids TEXT;  -- JSON array, null for csv
